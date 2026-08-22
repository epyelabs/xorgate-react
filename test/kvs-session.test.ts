import { describe, expect, it } from "vitest";
import { KvsViewerSession } from "../src/live/kvs-session.js";
import type {
  KvsSessionCallbacks,
  LiveVideoStatus,
  PeerConnectionLike,
  SignalingLike,
  TimerHost,
  WebRtcPlatform,
} from "../src/live/kvs-session.js";
import type { LiveCredentialResolver } from "../src/live/credential-resolver.js";
import { XorgateError } from "@xorgate/sdk";

/**
 * The reconnect machinery under a fake clock and a fake signaling client, as
 * the phase file prescribes: this logic has a history (the ten-minute freeze,
 * the ICE `disconnected` gap, the LTE watchdogs), and these tests are what
 * carries those fixes through the extraction.
 */

class FakeClock implements TimerHost {
  now = 0;
  private nextId = 1;
  private timers = new Map<number, { at: number; cb: () => void; intervalMs?: number }>();

  setTimeout(cb: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + ms, cb });
    return id;
  }
  clearTimeout(id: unknown): void {
    this.timers.delete(id as number);
  }
  setInterval(cb: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + ms, cb, intervalMs: ms });
    return id;
  }
  clearInterval(id: unknown): void {
    this.timers.delete(id as number);
  }

  /** Advance fake time, firing timers in order, flushing microtasks between. */
  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    for (;;) {
      let earliest: { id: number; at: number } | null = null;
      for (const [id, t] of this.timers) {
        if (t.at <= target && (earliest === null || t.at < earliest.at)) {
          earliest = { id, at: t.at };
        }
      }
      if (!earliest) break;
      const timer = this.timers.get(earliest.id)!;
      this.now = earliest.at;
      if (timer.intervalMs !== undefined) {
        timer.at = this.now + timer.intervalMs;
      } else {
        this.timers.delete(earliest.id);
      }
      timer.cb();
      await flushMicrotasks();
    }
    this.now = target;
    await flushMicrotasks();
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

class FakeSignaling implements SignalingLike {
  handlers = new Map<string, Array<(...a: unknown[]) => void>>();
  opened = false;
  closed = false;
  offers: unknown[] = [];
  on(event: string, cb: (...a: never[]) => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(cb as (...a: unknown[]) => void);
    this.handlers.set(event, list);
  }
  open(): void {
    this.opened = true;
  }
  close(): void {
    this.closed = true;
  }
  sendSdpOffer(offer: unknown): void {
    this.offers.push(offer);
  }
  sendIceCandidate(): void {}
  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(event) ?? []) cb(...args);
  }
}

class FakePc implements PeerConnectionLike {
  connectionState = "new";
  localDescription: unknown = null;
  closed = false;
  listeners = new Map<string, Array<(e: unknown) => void>>();
  addTransceiver(): unknown {
    return {};
  }
  async createOffer(): Promise<unknown> {
    return { type: "offer", sdp: "v=0" };
  }
  async setLocalDescription(desc: unknown): Promise<void> {
    this.localDescription = desc;
  }
  async setRemoteDescription(): Promise<void> {}
  async addIceCandidate(): Promise<void> {}
  addEventListener(type: string, cb: (e: never) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(cb as (e: unknown) => void);
    this.listeners.set(type, list);
  }
  async getStats(): Promise<Iterable<unknown> & { forEach(cb: (r: unknown) => void): void }> {
    return [] as unknown as Iterable<unknown> & { forEach(cb: (r: unknown) => void): void };
  }
  close(): void {
    this.closed = true;
  }
  emit(type: string, event: unknown): void {
    for (const cb of this.listeners.get(type) ?? []) cb(event);
  }
  setState(state: string): void {
    this.connectionState = state;
    this.emit("connectionstatechange", {});
  }
}

interface Attempt {
  signaling: FakeSignaling;
  pc: FakePc;
}

function makeHarness(options: { failEndpoints?: number } = {}) {
  const clock = new FakeClock();
  const attempts: Attempt[] = [];
  const statuses: Array<{ status: LiveVideoStatus; error: XorgateError | null }> = [];
  let endpointFailures = options.failEndpoints ?? 0;
  let vends = 0;

  const platform: WebRtcPlatform = {
    async getViewerEndpoints() {
      if (endpointFailures > 0) {
        endpointFailures--;
        throw new Error("endpoint resolution failed");
      }
      return { wss: "wss://v.example", https: "https://r.example" };
    },
    async getIceServers() {
      return [{ urls: "stun:example" }];
    },
    createSignaling() {
      const s = new FakeSignaling();
      const pc = new FakePc();
      attempts.push({ signaling: s, pc });
      return s;
    },
    createPeerConnection() {
      return attempts[attempts.length - 1].pc;
    },
    randomId: () => `id-${attempts.length}`,
  };

  const resolver = {
    getVideoSpec: async () => {
      vends++;
      return {
        credentials: {
          accessKeyId: "AK",
          secretAccessKey: "SK",
          sessionToken: "ST",
          expiresAtMs: null,
        },
        region: "us-east-1",
      };
    },
    invalidate: () => {
      /* recorded via vends on the next getVideoSpec */
    },
  } as unknown as Pick<LiveCredentialResolver, "getVideoSpec" | "invalidate">;

  const callbacks: KvsSessionCallbacks = {
    onStatus: (status, error) => statuses.push({ status, error }),
    onStats: () => {},
    onStream: () => {},
  };

  const session = new KvsViewerSession({
    channelRef: "arn:aws:kinesisvideo:us-east-1:1:channel/x/1",
    region: "us-east-1",
    resolver,
    platform,
    timers: clock,
    callbacks,
  });

  return {
    clock,
    attempts,
    statuses,
    session,
    vendCount: () => vends,
    latest: () => statuses[statuses.length - 1],
    connect: async (attempt: Attempt) => {
      attempt.signaling.emit("open");
      await flushMicrotasks();
      attempt.signaling.emit("sdpAnswer", { type: "answer" });
      await flushMicrotasks();
      attempt.pc.emit("track", { streams: [{ id: "stream" }] });
      attempt.pc.setState("connected");
      await flushMicrotasks();
    },
  };
}

describe("KvsViewerSession", () => {
  it("happy path: connecting → waiting (offer sent) → connected on track", async () => {
    const h = makeHarness();
    h.session.start();
    await flushMicrotasks();
    expect(h.attempts.length).toBe(1);
    expect(h.latest().status).toBe("connecting");

    h.attempts[0].signaling.emit("open");
    await flushMicrotasks();
    expect(h.attempts[0].signaling.offers.length).toBe(1);
    expect(h.latest().status).toBe("waiting");

    await h.connect(h.attempts[0]);
    expect(h.latest().status).toBe("connected");
    h.session.destroy();
  });

  it("15 s connect deadline: an unanswered offer tears down and re-offers on a fresh session", async () => {
    const h = makeHarness();
    h.session.start();
    await flushMicrotasks();
    h.attempts[0].signaling.emit("open");
    await flushMicrotasks();
    expect(h.latest().status).toBe("waiting");

    // No answer ever arrives (the master is offline; the signaling plane does
    // not queue offers). The whole-attempt deadline must fire.
    await h.clock.advance(15_000);
    expect(h.latest().status).toBe("closed");
    expect(h.attempts[0].signaling.closed).toBe(true);
    expect(h.attempts[0].pc.closed).toBe(true);

    // Backoff (1 s after the first failure) then a FRESH session.
    await h.clock.advance(1_000);
    expect(h.attempts.length).toBe(2);
    expect(h.attempts[1].signaling).not.toBe(h.attempts[0].signaling);
    h.session.destroy();
  });

  it("10 s step deadline: a hanging pre-signaling call becomes an error and a retry", async () => {
    const h = makeHarness();
    // getViewerEndpoints hangs forever on the first attempt.
    const platform = h.session as unknown as { opts: { platform: WebRtcPlatform } };
    const original = platform.opts.platform.getViewerEndpoints;
    let hang = true;
    platform.opts.platform.getViewerEndpoints = async (...args) => {
      if (hang) {
        hang = false;
        return new Promise(() => {});
      }
      return original(...args);
    };
    h.session.start();
    await flushMicrotasks();
    expect(h.latest().status).toBe("connecting");
    await h.clock.advance(10_000);
    expect(h.latest().status).toBe("error");
    expect(h.latest().error?.code).toBe("TIMEOUT");
    // Reconnect scheduled; the second attempt resolves endpoints normally.
    await h.clock.advance(1_000);
    expect(h.attempts.length).toBe(1);
    h.session.destroy();
  });

  it("ICE `disconnected` gets a 2.5 s grace, then forces a fresh session", async () => {
    const h = makeHarness();
    h.session.start();
    await flushMicrotasks();
    await h.connect(h.attempts[0]);
    expect(h.latest().status).toBe("connected");

    h.attempts[0].pc.setState("disconnected");
    await flushMicrotasks();
    // Inside the grace: nothing torn down yet.
    await h.clock.advance(2_000);
    expect(h.attempts[0].pc.closed).toBe(false);
    // Past the grace: fresh session.
    await h.clock.advance(500);
    expect(h.attempts[0].pc.closed).toBe(true);
    expect(h.latest().status === "closed" || h.latest().status === "connecting").toBe(true);
    h.session.destroy();
  });

  it("ICE `disconnected` that recovers inside the grace is left alone", async () => {
    const h = makeHarness();
    h.session.start();
    await flushMicrotasks();
    await h.connect(h.attempts[0]);

    h.attempts[0].pc.setState("disconnected");
    await h.clock.advance(1_000);
    h.attempts[0].pc.setState("connected");
    await h.clock.advance(5_000);
    expect(h.attempts[0].pc.closed).toBe(false);
    expect(h.attempts.length).toBe(1);
    h.session.destroy();
  });

  it("backoff doubles across failures and resets on the first inbound track", async () => {
    const h = makeHarness({ failEndpoints: 3 });
    h.session.start();
    await flushMicrotasks();
    expect(h.latest().status).toBe("error");
    // Failure 1 → retry after 1 s (fails), failure 2 → 2 s (fails),
    // failure 3 → 4 s (succeeds to signaling).
    await h.clock.advance(1_000);
    await h.clock.advance(2_000);
    await h.clock.advance(4_000);
    expect(h.attempts.length).toBe(1);
    await h.connect(h.attempts[0]);
    expect(h.latest().status).toBe("connected");

    // After the track reset, the next failure backs off from 1 s again.
    h.attempts[0].pc.setState("failed");
    await flushMicrotasks();
    await h.clock.advance(1_000);
    expect(h.attempts.length).toBe(2);
    h.session.destroy();
  });

  it("a stale attempt resuming after an await cannot cross-wire a newer session", async () => {
    const h = makeHarness();
    h.session.start();
    await flushMicrotasks();
    const first = h.attempts[0];
    // A nudge starts a NEWER attempt while the first is still live.
    h.session.nudge();
    await flushMicrotasks();
    expect(h.attempts.length).toBe(2);
    // The first session was torn down by the newer open().
    expect(first.pc.closed).toBe(true);
    // Late events from the stale session must not disturb the new one.
    const before = h.statuses.length;
    first.signaling.emit("error", new Error("stale socket died"));
    first.signaling.emit("close");
    await flushMicrotasks();
    expect(h.statuses.length).toBe(before);
    h.session.destroy();
  });

  it("the ~50 minute refresh cycle re-vends credentials and reopens", async () => {
    const h = makeHarness();
    h.session.start();
    await flushMicrotasks();
    await h.connect(h.attempts[0]);
    expect(h.vendCount()).toBe(1);
    await h.clock.advance(50 * 60 * 1000);
    expect(h.attempts.length).toBe(2);
    expect(h.vendCount()).toBe(2);
    h.session.destroy();
  });

  it("nudge() skips a pending backoff and reconnects immediately", async () => {
    const h = makeHarness({ failEndpoints: 1 });
    h.session.start();
    await flushMicrotasks();
    expect(h.latest().status).toBe("error");
    // A reconnect is scheduled for 1 s out; the nudge must not wait for it.
    h.session.nudge();
    await flushMicrotasks();
    expect(h.attempts.length).toBe(1);
    h.session.destroy();
  });

  it("destroy() cancels every timer and closes the session", async () => {
    const h = makeHarness();
    h.session.start();
    await flushMicrotasks();
    await h.connect(h.attempts[0]);
    h.session.destroy();
    expect(h.attempts[0].pc.closed).toBe(true);
    expect(h.attempts[0].signaling.closed).toBe(true);
    const before = h.attempts.length;
    await h.clock.advance(60 * 60 * 1000);
    expect(h.attempts.length).toBe(before);
  });
});
