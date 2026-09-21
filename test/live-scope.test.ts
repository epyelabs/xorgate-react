import { describe, expect, it, vi } from "vitest";
import { LiveCredentialResolver } from "../src/live/credential-resolver.js";
import type { LiveCredentials } from "../src/config.js";

/**
 * `LiveCredentialResolver`'s scope half: what tenancy the current credential
 * was vended for, and what happens when that tenancy changes underneath it.
 *
 * The bug this exists to prevent is silent. A vended credential encodes
 * org + workspace in its session policy and is cached here for up to ~50
 * minutes; when a device is transferred inside that window the MQTT
 * subscription names a topic the device no longer publishes on, the socket
 * stays `connected`, and no frame ever arrives. Nothing throws.
 */

const VEND = (workspaceId: string | undefined): LiveCredentials =>
  ({
    accessKeyId: "AK",
    secretAccessKey: "SK",
    sessionToken: "ST",
    expiration: new Date(Date.now() + 3_600_000).toISOString(),
    organizationId: "org-1",
    ...(workspaceId !== undefined ? { workspaceId } : {}),
    live: { region: "us-east-1", realtimeEndpoint: "example-ats.iot.us-east-1.amazonaws.com" },
  }) as LiveCredentials;

function makeResolver(vend: () => LiveCredentials, tenancy: {
  organizationId: string | null;
  workspaceId: string | undefined;
} = { organizationId: null, workspaceId: undefined }) {
  return new LiveCredentialResolver({
    getAuth: () => ({ getLiveCredentials: async () => vend() }),
    getConfig: () => ({ baseUrl: "https://api.example.test" }),
    getRest: () => ({ kind: "no-credential" }),
    getTenancy: () => tenancy,
  });
}

describe("LiveCredentialResolver scope", () => {
  it("learns the vend's tenancy and reports it through scope()", async () => {
    const resolver = makeResolver(() => VEND("ws-1"));
    expect(resolver.scope()).toEqual({ organizationId: null, workspaceId: null });
    await resolver.getCredentials();
    expect(resolver.scope()).toEqual({ organizationId: "org-1", workspaceId: "ws-1" });
  });

  it("falls back to the provider's tenancy before anything has been vended", () => {
    const resolver = makeResolver(() => VEND("ws-1"), {
      organizationId: "org-9",
      workspaceId: "ws-9",
    });
    expect(resolver.scope()).toEqual({ organizationId: "org-9", workspaceId: "ws-9" });
  });

  it("coversWorkspace is true, false, or null — and null is a real answer", async () => {
    const scoped = makeResolver(() => VEND("ws-1"));
    await scoped.getCredentials();
    expect(scoped.coversWorkspace("ws-1")).toBe(true);
    expect(scoped.coversWorkspace("ws-2")).toBe(false);

    // An ORGANISATION-scoped credential may reach any workspace in its org, and
    // this resolver does not know which those are. "Cannot tell" must not read
    // as "out of scope".
    const orgWide = makeResolver(() => VEND(undefined));
    await orgWide.getCredentials();
    expect(orgWide.scope().workspaceId).toBeNull();
    expect(orgWide.coversWorkspace("anything")).toBeNull();
  });

  it("invalidate() drops the credential but KEEPS the learned scope", async () => {
    let workspaceId = "ws-1";
    const vend = vi.fn(() => VEND(workspaceId));
    const resolver = makeResolver(vend);
    await resolver.getCredentials();
    resolver.invalidate();
    expect(resolver.scope().workspaceId).toBe("ws-1");
    await resolver.getCredentials();
    expect(vend).toHaveBeenCalledTimes(2);
  });

  it("invalidate() notifies NOBODY: it is the expiry path the KVS timer uses", async () => {
    const resolver = makeResolver(() => VEND("ws-1"));
    const listener = vi.fn();
    resolver.onInvalidate(listener);
    resolver.invalidate();
    expect(listener).not.toHaveBeenCalled();
  });

  it("invalidateScope() forgets the scope, re-vends, and notifies every listener", async () => {
    let workspaceId = "ws-1";
    const resolver = makeResolver(() => VEND(workspaceId));
    await resolver.getCredentials();
    expect(resolver.coversWorkspace("ws-2")).toBe(false);

    const a = vi.fn();
    const b = vi.fn();
    resolver.onInvalidate(a);
    resolver.onInvalidate(b);

    workspaceId = "ws-2"; // the device was transferred
    resolver.invalidateScope();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    // Forgotten immediately, relearned on the next vend.
    expect(resolver.scope().workspaceId).toBeNull();
    await resolver.getCredentials();
    expect(resolver.coversWorkspace("ws-2")).toBe(true);
  });

  it("invalidateScope() drops a vend that was ALREADY IN FLIGHT, rather than adopting it", async () => {
    // The org-switch defect, reproduced on hardware 2026-09-21: a vend issued
    // for the tenant being left is still pending when the switch happens.
    // `getCredentials()` hands back a pending `inflight` promise before it
    // considers minting, so without this the OLD tenant's credential becomes
    // the NEW tenant's cached one -- and live video fails `AccessDenied`
    // against the new tenant's KVS channel for the credential's full lifetime.
    let workspaceId = "ws-old";
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let vends = 0;
    const resolver = new LiveCredentialResolver({
      getAuth: () => ({
        getLiveCredentials: async () => {
          vends += 1;
          const ws = workspaceId;
          if (vends === 1) await gate; // the first vend is still in flight
          return VEND(ws);
        },
      }),
      getConfig: () => ({ baseUrl: "https://api.example.test" }),
      getRest: () => ({ kind: "no-credential" }),
      getTenancy: () => ({ organizationId: null, workspaceId: undefined }),
    });

    const pending = resolver.getCredentials(); // in flight for ws-old

    workspaceId = "ws-new"; // the operator switched organizations
    resolver.invalidateScope();

    release();
    await pending; // the orphaned vend resolves AFTER the switch

    // It must not have become the new tenant's credential.
    expect(resolver.scope().workspaceId).toBeNull();
    expect(resolver.coversWorkspace("ws-new")).toBeNull();

    // The next resolve mints fresh, for the tenant we are actually in.
    await resolver.getCredentials();
    expect(vends).toBe(2);
    expect(resolver.coversWorkspace("ws-new")).toBe(true);
    expect(resolver.coversWorkspace("ws-old")).toBe(false);
  });

  it("a throwing listener does not stop the others being told", () => {
    const resolver = makeResolver(() => VEND("ws-1"));
    const after = vi.fn();
    resolver.onInvalidate(() => {
      throw new Error("consumer blew up");
    });
    resolver.onInvalidate(after);
    expect(() => resolver.invalidateScope()).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("unsubscribing stops the notifications", () => {
    const resolver = makeResolver(() => VEND("ws-1"));
    const listener = vi.fn();
    const off = resolver.onInvalidate(listener);
    off();
    resolver.invalidateScope();
    expect(listener).not.toHaveBeenCalled();
  });

  it("the MQTT topic follows the NEW scope after invalidateScope()", async () => {
    let workspaceId = "ws-1";
    const resolver = makeResolver(() => VEND(workspaceId));
    const before = await resolver.getMqttSpec("dev-1");
    expect(before.topics).toEqual([
      "xorgate/orgs/org-1/ws/ws-1/devices/dev-1/telemetry",
    ]);

    workspaceId = "ws-2";
    resolver.invalidateScope();
    const after = await resolver.getMqttSpec("dev-1");
    expect(after.topics).toEqual([
      "xorgate/orgs/org-1/ws/ws-2/devices/dev-1/telemetry",
    ]);
  });

  it("scope() carries no credential material, so it is safe to render", async () => {
    const resolver = makeResolver(() => VEND("ws-1"));
    await resolver.getCredentials();
    expect(JSON.stringify(resolver.scope())).not.toContain("SK");
    expect(JSON.stringify(resolver)).toBe('{"mode":"vended-direct"}');
  });
});
