import { describe, expect, it, vi } from "vitest";
import { acquireFeed, releaseFeed, TelemetryFeed } from "../src/live/telemetry-feed.js";
import type { MqttLikeClient } from "../src/live/telemetry-feed.js";
import type {
  LiveCredentialResolver,
  MqttConnectionSpec,
} from "../src/live/credential-resolver.js";
import { XorgateError } from "@xorgate/sdk";

const SPEC: MqttConnectionSpec = {
  credentials: { accessKeyId: "AK", secretAccessKey: "SK", sessionToken: "ST", expiresAtMs: null },
  region: "us-east-1",
  endpoint: "example-ats.iot.us-east-1.amazonaws.com",
  clientId: "xgl-test",
  topics: ["xorgate/orgs/org-1/ws/ws-1/devices/dev-1/telemetry"],
};

class FakeMqtt implements MqttLikeClient {
  handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  subscriptions: string[] = [];
  ended = false;
  on(event: string, cb: (...args: unknown[]) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(cb);
    this.handlers.set(event, list);
    return this;
  }
  subscribe(topic: string): this {
    this.subscriptions.push(topic);
    return this;
  }
  end(): this {
    this.ended = true;
    this.emit("close");
    return this;
  }
  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(event) ?? []) cb(...args);
  }
}

function stubResolver(overrides: Partial<Record<string, unknown>> = {}): LiveCredentialResolver {
  return {
    telemetryAvailability: () => ({ available: true, reason: null }),
    getMqttSpec: async () => SPEC,
    ...overrides,
  } as unknown as LiveCredentialResolver;
}

function encode(json: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(json));
}

async function settle(until?: () => boolean): Promise<void> {
  // The connect path awaits a dynamic import (the SigV4 module), so a fixed
  // two-tick settle is not enough on the first, cold test.
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 1));
    if (!until || until()) return;
  }
}

function makeFeed(options: {
  resolver?: LiveCredentialResolver;
  now?: () => number;
} = {}): { feed: TelemetryFeed; mqtt: () => FakeMqtt | null } {
  let client: FakeMqtt | null = null;
  const feed = new TelemetryFeed({
    resolver: options.resolver ?? stubResolver(),
    deviceId: "dev-1",
    connect: async () => {
      client = new FakeMqtt();
      return client;
    },
    ...(options.now ? { now: options.now } : {}),
  });
  return { feed, mqtt: () => client };
}

describe("TelemetryFeed", () => {
  it("connects, subscribes to the resolver's topics, and reports connected", async () => {
    const { feed, mqtt } = makeFeed();
    feed.start();
    await settle(() => mqtt() !== null);
    mqtt()!.emit("connect");
    expect(feed.snapshot().status).toBe("connected");
    expect(mqtt()!.subscriptions).toEqual(SPEC.topics);
    feed.stop();
  });

  it("flattens metrics into the SDK interop shape (metric, nullable unit, ISO ts)", async () => {
    const now = 1_754_400_000_000;
    const { feed, mqtt } = makeFeed({ now: () => now });
    feed.start();
    await settle(() => mqtt() !== null);
    mqtt()!.emit("connect");
    const deviceTs = 1_754_399_999_000;
    mqtt()!.emit(
      "message",
      SPEC.topics[0],
      encode({
        v: 1,
        deviceId: "dev-1",
        ts: deviceTs,
        metrics: {
          gps: { lat: { value: 43.66, unit: "deg" }, lon: { value: -79.51 } },
        },
      }),
    );
    feed.ingest; // (message path already ingested)
    const snap = await flushed(feed);
    expect(snap.latest["gps.lat"]).toEqual({
      metric: "gps.lat",
      value: 43.66,
      unit: "deg",
      ts: new Date(deviceTs).toISOString(),
    });
    expect(snap.latest["gps.lon"]).toMatchObject({ unit: null });
    // History keeps epoch ms for charts.
    expect(snap.history).toEqual([{ ts: deviceTs, "gps.lat": 43.66, "gps.lon": -79.51 }]);
    // receivedAt is the BROWSER clock, not the payload's.
    expect(snap.receivedAt).toBe(now);
    feed.stop();
  });

  it("keeps the last seen recording/media blocks when a payload omits them", async () => {
    const { feed, mqtt } = makeFeed();
    feed.start();
    await settle(() => mqtt() !== null);
    mqtt()!.emit("connect");
    const recording = {
      enabled: true,
      sessionId: "s1",
      backlogBytes: 0,
      backlogSegments: 0,
      droppedSegments: 0,
      uploading: false,
      lastUploadAt: null,
    };
    mqtt()!.emit("message", SPEC.topics[0], encode({ v: 1, ts: 1, metrics: {}, recording }));
    let snap = await flushed(feed);
    expect(snap.recording).toMatchObject({ enabled: true, sessionId: "s1" });
    // Next payload omits the block: it must NOT flicker back to null.
    mqtt()!.emit("message", SPEC.topics[0], encode({ v: 1, ts: 2, metrics: {} }));
    snap = await flushed(feed);
    expect(snap.recording).toMatchObject({ enabled: true, sessionId: "s1" });
    feed.stop();
  });

  it("caps the history ring buffer and trims from the front", async () => {
    const { feed, mqtt } = makeFeed();
    feed.tune({ historyLimit: 300 });
    feed.start();
    await settle(() => mqtt() !== null);
    mqtt()!.emit("connect");
    for (let i = 0; i < 310; i++) {
      mqtt()!.emit("message", SPEC.topics[0], encode({ v: 1, ts: i, metrics: {} }));
    }
    const snap = await flushed(feed);
    expect(snap.history.length).toBe(300);
    expect(snap.history[0].ts).toBe(10);
    feed.stop();
  });

  it("drops malformed frames silently", async () => {
    const { feed, mqtt } = makeFeed();
    feed.start();
    await settle(() => mqtt() !== null);
    mqtt()!.emit("connect");
    mqtt()!.emit("message", SPEC.topics[0], new TextEncoder().encode("not json"));
    mqtt()!.emit("message", SPEC.topics[0], encode({ v: 2, ts: 1 }));
    mqtt()!.emit("message", SPEC.topics[0], encode({ v: 1, ts: "bad" }));
    const snap = feed.snapshot();
    expect(snap.history).toEqual([]);
    expect(snap.status).toBe("connected");
    feed.stop();
  });

  it("reports unavailable (with the reason) without connecting", () => {
    const resolver = stubResolver({
      telemetryAvailability: () => ({ available: false, reason: "not-configured" }),
      getMqttSpec: async () => {
        throw new Error("must not be called");
      },
    });
    const { feed } = makeFeed({ resolver });
    feed.start();
    const snap = feed.snapshot();
    expect(snap.status).toBe("unavailable");
    expect(snap.unavailableReason).toBe("not-configured");
    feed.stop();
  });

  it("stays `connecting` on a pending-auth failure (signed out) instead of erroring", async () => {
    const resolver = stubResolver({
      getMqttSpec: async () => {
        throw new XorgateError({
          code: "UNAUTHORIZED",
          message: "no session yet",
          details: { pendingAuth: true },
        });
      },
    });
    const { feed } = makeFeed({ resolver });
    feed.start();
    await settle();
    const snap = feed.snapshot();
    expect(snap.status).toBe("connecting");
    expect(snap.error).toBeNull();
    feed.stop();
  });

  it("surfaces a real failure as `error` with a XorgateError", async () => {
    const resolver = stubResolver({
      getMqttSpec: async () => {
        throw new XorgateError({ code: "INVALID_CONFIG", message: "missing endpoint" });
      },
    });
    const { feed } = makeFeed({ resolver });
    feed.start();
    await settle();
    const snap = feed.snapshot();
    expect(snap.status).toBe("error");
    expect(snap.error?.code).toBe("INVALID_CONFIG");
    feed.stop();
  });
});

describe("feed registry", () => {
  it("shares one feed per (resolver, device) and closes on the last release", async () => {
    const resolver = stubResolver();
    const connect = vi.fn(async () => new FakeMqtt());
    const a = acquireFeed(resolver, "dev-1", { connect });
    const b = acquireFeed(resolver, "dev-1", { connect });
    expect(b).toBe(a);
    await settle();
    expect(connect).toHaveBeenCalledTimes(1);

    const other = acquireFeed(resolver, "dev-2", { connect });
    expect(other).not.toBe(a);

    releaseFeed(resolver, "dev-1", a);
    releaseFeed(resolver, "dev-1", b);
    // A fresh acquire after the last release starts a NEW feed.
    const c = acquireFeed(resolver, "dev-1", { connect });
    expect(c).not.toBe(a);
    releaseFeed(resolver, "dev-1", c);
    releaseFeed(resolver, "dev-2", other);
  });

  it("does not share feeds across resolvers (two providers cannot cross-wire)", () => {
    const r1 = stubResolver();
    const r2 = stubResolver();
    const connect = vi.fn(async () => new FakeMqtt());
    const a = acquireFeed(r1, "dev-1", { connect });
    const b = acquireFeed(r2, "dev-1", { connect });
    expect(a).not.toBe(b);
    releaseFeed(r1, "dev-1", a);
    releaseFeed(r2, "dev-1", b);
  });
});

/** Wait for the coalescing flush (default 250 ms) to publish a snapshot. */
async function flushed(feed: TelemetryFeed): Promise<ReturnType<TelemetryFeed["snapshot"]>> {
  await new Promise<void>((resolve) => {
    const unsub = feed.subscribe(() => {
      unsub();
      resolve();
    });
    // In case the flush already ran before we subscribed.
    setTimeout(() => {
      unsub();
      resolve();
    }, 400);
  });
  return feed.snapshot();
}
