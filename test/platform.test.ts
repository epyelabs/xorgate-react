import { describe, expect, it } from "vitest";
import { LiveCredentialResolver } from "../src/live/credential-resolver.js";
import { TelemetryFeed } from "../src/live/telemetry-feed.js";
import type { MqttLikeClient } from "../src/live/telemetry-feed.js";
import type { MqttConnectionSpec } from "../src/live/credential-resolver.js";
import { browserPlatform, browserRandomId } from "../src/platform.js";

/**
 * The platform slot (0.2.0): every host-runtime touchpoint is optional and
 * defaults to the browser. These tests pin the two contracts a React Native
 * platform relies on — the resolver draws client ids from `randomId`, and a
 * wake reconnects a closed feed NOW — without a DOM.
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

function resolverWith(platform: { randomId?: () => string } | undefined): LiveCredentialResolver {
  return new LiveCredentialResolver({
    getAuth: () => ({ getLiveCredentials: async () => VEND }),
    getConfig: () => ({ baseUrl: "https://api.example" }),
    getRest: () => ({ kind: "no-credential" }),
    getTenancy: () => ({ organizationId: null, workspaceId: undefined }),
    ...(platform ? { getPlatform: () => platform } : {}),
  });
}

describe("platform: randomId", () => {
  it("the resolver draws vended MQTT client ids from the platform's randomId", async () => {
    let calls = 0;
    const resolver = resolverWith({
      randomId: () => {
        calls++;
        return "fixed-id";
      },
    });
    const spec = await resolver.getMqttSpec("dev-1");
    expect(spec.clientId).toBe("xgl-fixed-id");
    expect(calls).toBe(1);
    expect(spec.topics).toEqual(["xorgate/orgs/org-1/ws/ws-1/devices/dev-1/telemetry"]);
  });

  it("without a platform the browser default (crypto.randomUUID) is used", async () => {
    const resolver = resolverWith(undefined);
    const spec = await resolver.getMqttSpec("dev-1");
    expect(spec.clientId).toMatch(/^xgl-[0-9a-f-]{36}$/);
  });

  it("browserRandomId names the platform slot when the runtime has no crypto", () => {
    const g = globalThis as { crypto?: unknown };
    const saved = g.crypto;
    Object.defineProperty(g, "crypto", { value: undefined, configurable: true, writable: true });
    try {
      expect(() => browserRandomId()).toThrow(/platform/);
    } finally {
      Object.defineProperty(g, "crypto", { value: saved, configurable: true, writable: true });
    }
  });

  it("browserPlatform() carries the wake source and the id source", () => {
    const p = browserPlatform();
    expect(typeof p.subscribeWake).toBe("function");
    expect(typeof p.randomId).toBe("function");
    // No window/document here: the browser wake source is a no-op subscription.
    const unsubscribe = p.subscribeWake(() => undefined);
    expect(typeof unsubscribe).toBe("function");
    unsubscribe();
  });
});

const SPEC: MqttConnectionSpec = {
  credentials: { accessKeyId: "AK", secretAccessKey: "SK", sessionToken: "ST", expiresAtMs: null },
  region: "us-east-1",
  endpoint: "example-ats.iot.us-east-1.amazonaws.com",
  clientId: "xgl-test",
  topics: ["xorgate/orgs/org-1/ws/ws-1/devices/dev-1/telemetry"],
};

class FakeMqtt implements MqttLikeClient {
  handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  ended = false;
  on(event: string, cb: (...args: unknown[]) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(cb);
    this.handlers.set(event, list);
    return this;
  }
  subscribe(): this {
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

async function settle(until: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 1));
    if (until()) return;
  }
}

describe("platform: wake nudge on the telemetry feed", () => {
  function feedWithWake() {
    const clients: FakeMqtt[] = [];
    let wake: (() => void) | null = null;
    let unsubscribed = 0;
    const feed = new TelemetryFeed({
      resolver: {
        telemetryAvailability: () => ({ available: true, reason: null }),
        getMqttSpec: async () => SPEC,
      } as unknown as LiveCredentialResolver,
      deviceId: "dev-1",
      connect: async () => {
        const c = new FakeMqtt();
        clients.push(c);
        return c;
      },
      subscribeWake: (onWake) => {
        wake = onWake;
        return () => {
          unsubscribed++;
        };
      },
    });
    return { feed, clients, wake: () => wake?.(), unsubscribed: () => unsubscribed };
  }

  it("a wake while closed skips the backoff and reconnects immediately", async () => {
    const h = feedWithWake();
    h.feed.start();
    await settle(() => h.clients.length === 1);
    h.clients[0].emit("connect");
    expect(h.feed.snapshot().status).toBe("connected");

    // The socket drops: closed, with a 1 s backoff pending.
    h.clients[0].emit("close");
    expect(h.feed.snapshot().status).toBe("closed");
    expect(h.clients.length).toBe(1);

    // The app comes back: a second client is opened NOW, not after the backoff.
    h.wake();
    await settle(() => h.clients.length === 2);
    expect(h.clients.length).toBe(2);
    h.clients[1].emit("connect");
    expect(h.feed.snapshot().status).toBe("connected");
    h.feed.stop();
  });

  it("a wake while connected or connecting is a no-op", async () => {
    const h = feedWithWake();
    h.feed.start();
    // Still connecting (the fake connect has not resolved yet): no second client.
    h.wake();
    await settle(() => h.clients.length === 1);
    await new Promise((r) => setTimeout(r, 5));
    expect(h.clients.length).toBe(1);
    h.clients[0].emit("connect");
    h.wake();
    await new Promise((r) => setTimeout(r, 5));
    expect(h.clients.length).toBe(1);
    expect(h.feed.snapshot().status).toBe("connected");
    h.feed.stop();
  });

  it("a stale open() that finishes after a wake does not attach a second client", async () => {
    // First connect hangs; a wake after a failure must win the race.
    let resolveFirst: ((c: MqttLikeClient) => void) | null = null;
    const clients: FakeMqtt[] = [];
    let wake: (() => void) | null = null;
    let calls = 0;
    const feed = new TelemetryFeed({
      resolver: {
        telemetryAvailability: () => ({ available: true, reason: null }),
        getMqttSpec: async () => {
          calls++;
          if (calls === 1) throw new Error("boom");
          return SPEC;
        },
      } as unknown as LiveCredentialResolver,
      deviceId: "dev-1",
      connect: async () => {
        const c = new FakeMqtt();
        clients.push(c);
        if (clients.length === 1) {
          return new Promise<MqttLikeClient>((r) => {
            resolveFirst = r;
          });
        }
        return c;
      },
      subscribeWake: (onWake) => {
        wake = onWake;
        return () => undefined;
      },
    });
    feed.start();
    await settle(() => feed.snapshot().status === "error");
    wake!();
    await settle(() => clients.length === 1);
    // The reconnect from the wake is in flight (its connect hangs). A second
    // wake in the error state is now a no-op because status is connecting.
    expect(feed.snapshot().status).toBe("connecting");
    resolveFirst!(clients[0]);
    await settle(() => feed.snapshot().status !== "connecting" || clients[0].handlers.size > 0);
    clients[0].emit("connect");
    expect(feed.snapshot().status).toBe("connected");
    feed.stop();
    expect(clients[0].ended).toBe(true);
  });

  it("stop() unsubscribes the wake source", async () => {
    const h = feedWithWake();
    h.feed.start();
    await settle(() => h.clients.length === 1);
    h.feed.stop();
    expect(h.unsubscribed()).toBe(1);
  });
});
