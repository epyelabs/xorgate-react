// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { XorgateProvider } from "../src/context.js";
import { useLiveVideoSession } from "../src/live/use-live-video-session.js";
import type {
  PeerConnectionLike,
  SignalingLike,
  WebRtcPlatform,
} from "../src/live/kvs-session.js";
import type { XorgatePlatform } from "../src/platform.js";

/**
 * `useLiveVideoSession` over a fake WebRTC platform handed in through the
 * provider's `platform` prop: the session reaches `connected`, `onStream`
 * receives the stream, and the platform's wake source nudges the session.
 * This is the contract `@xorgate/react-native` builds its `useLiveVideo` on.
 */

const VEND = {
  accessKeyId: "AK",
  secretAccessKey: "SK",
  sessionToken: "ST",
  expiration: new Date(Date.now() + 3600_000).toISOString(),
  organizationId: "org-1",
  workspaceId: "ws-1",
  live: { region: "us-east-1", realtimeEndpoint: "example-ats.iot.us-east-1.amazonaws.com" },
};

class FakeSignaling implements SignalingLike {
  handlers = new Map<string, Array<(...a: unknown[]) => void>>();
  opened = false;
  closed = false;
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
  sendSdpOffer(): void {}
  sendIceCandidate(): void {}
  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(event) ?? []) cb(...args);
  }
}

class FakePc implements PeerConnectionLike {
  connectionState = "new";
  localDescription: unknown = { type: "offer" };
  handlers = new Map<string, Array<(e: never) => void>>();
  closed = false;
  addTransceiver(): unknown {
    return {};
  }
  async createOffer(): Promise<unknown> {
    return { type: "offer" };
  }
  async setLocalDescription(): Promise<void> {}
  async setRemoteDescription(): Promise<void> {}
  async addIceCandidate(): Promise<void> {}
  addEventListener(type: string, cb: (event: never) => void): void {
    const list = this.handlers.get(type) ?? [];
    list.push(cb);
    this.handlers.set(type, list);
  }
  async getStats(): Promise<Iterable<unknown> & { forEach(cb: (r: unknown) => void): void }> {
    return [];
  }
  close(): void {
    this.closed = true;
  }
  emit(type: string, event: unknown): void {
    for (const cb of this.handlers.get(type) ?? []) cb(event as never);
  }
}

function makePlatform() {
  const attempts: Array<{ signaling: FakeSignaling; pc: FakePc; clientId: string }> = [];
  let wake: (() => void) | null = null;
  const webrtc: WebRtcPlatform = {
    getViewerEndpoints: async () => ({ wss: "wss://x", https: "https://x" }),
    getIceServers: async () => [],
    createSignaling: (args) => {
      const signaling = new FakeSignaling();
      attempts.push({ signaling, pc: null as unknown as FakePc, clientId: args.clientId });
      return signaling;
    },
    createPeerConnection: () => {
      const pc = new FakePc();
      attempts[attempts.length - 1].pc = pc;
      return pc;
    },
    randomId: () => `native-${attempts.length}`,
  };
  const platform: XorgatePlatform = {
    createWebRtcPlatform: () => webrtc,
    subscribeWake: (onWake) => {
      wake = onWake;
      return () => {
        wake = null;
      };
    },
    randomId: () => "native-id",
  };
  return { platform, attempts, wake: () => wake?.(), hasWake: () => wake !== null };
}

function wrapperFor(platform: XorgatePlatform) {
  return ({ children }: { children: ReactNode }) =>
    createElement(XorgateProvider, {
      auth: { getLiveCredentials: async () => VEND },
      organizationId: null,
      config: {},
      platform,
      children,
    });
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await act(async () => Promise.resolve());
}

const CHANNEL = { streamKey: "cam0", channelName: "c", channelRef: "arn:x", region: "us-east-1" } as never;

describe("useLiveVideoSession over a platform", () => {
  it("runs the session on the platform's WebRTC and hands the stream to onStream", async () => {
    const p = makePlatform();
    const streams: unknown[] = [];
    const { result } = renderHook(
      () => useLiveVideoSession(CHANNEL, { onStream: (s) => streams.push(s) }),
      { wrapper: wrapperFor(p.platform) },
    );
    expect(result.current.status).toBe("connecting");
    await flush();
    expect(p.attempts.length).toBe(1);
    expect(p.attempts[0].clientId).toBe("native-0");
    expect(p.attempts[0].signaling.opened).toBe(true);

    await act(async () => {
      p.attempts[0].signaling.emit("open");
    });
    await flush();
    expect(result.current.status).toBe("waiting");

    await act(async () => {
      p.attempts[0].pc.emit("track", { streams: [{ id: "remote" }] });
    });
    expect(result.current.status).toBe("connected");
    expect(streams).toEqual([{ id: "remote" }]);
  });

  it("the platform's wake source nudges a closed session into a fresh attempt", async () => {
    const p = makePlatform();
    const { result } = renderHook(
      () => useLiveVideoSession(CHANNEL, { onStream: () => undefined }),
      { wrapper: wrapperFor(p.platform) },
    );
    await flush();
    expect(p.hasWake()).toBe(true);
    await act(async () => {
      p.attempts[0].signaling.emit("close");
    });
    expect(result.current.status).toBe("closed");
    expect(p.attempts.length).toBe(1);
    await act(async () => {
      p.wake();
    });
    await flush();
    expect(p.attempts.length).toBe(2);
    expect(p.attempts[0].pc.closed).toBe(true);
  });

  it("unmounting destroys the session and unsubscribes the wake source", async () => {
    const p = makePlatform();
    const { unmount } = renderHook(
      () => useLiveVideoSession(CHANNEL, { onStream: () => undefined }),
      { wrapper: wrapperFor(p.platform) },
    );
    await flush();
    unmount();
    expect(p.hasWake()).toBe(false);
    expect(p.attempts[0].pc.closed).toBe(true);
    expect(p.attempts[0].signaling.closed).toBe(true);
  });
});
