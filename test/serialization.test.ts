import { describe, expect, it } from "vitest";
import { LiveCredentialResolver } from "../src/live/credential-resolver.js";
import type { XorgateAuth } from "../src/config.js";

/**
 * TypeScript's `private` is a compile-time fiction: `@xorgate/sdk@0.1.0`
 * shipped a credential leak reachable from `JSON.stringify(client)` after 127
 * green tests. The browser makes this worse — React DevTools serializes
 * context values and an error boundary serializes whatever it was holding —
 * so anything reachable from context must survive being serialized by
 * somebody's error reporter.
 */

const SECRETS = ["SECRETACCESSKEY-x9", "SESSIONTOKEN-x9", "xg_supersecret"];

function makeResolver(): LiveCredentialResolver {
  const auth: XorgateAuth = {
    getLiveCredentials: async () => ({
      accessKeyId: "AKIA-TEST",
      secretAccessKey: "SECRETACCESSKEY-x9",
      sessionToken: "SESSIONTOKEN-x9",
      expiration: new Date(Date.now() + 3_600_000).toISOString(),
      organizationId: "org-1",
      workspaceId: "ws-1",
      live: { region: "us-east-1", realtimeEndpoint: "x-ats.iot.us-east-1.amazonaws.com" },
    }),
    apiKey: "xg_supersecret",
  };
  return new LiveCredentialResolver({
    getAuth: () => auth,
    getConfig: () => ({ baseUrl: "https://api.xorgate.io" }),
    getRest: () => ({ kind: "no-organization" }),
    getTenancy: () => ({ organizationId: "org-1", workspaceId: undefined }),
  });
}

describe("credential resolver serialization safety", () => {
  it("serializes to the mode only, before any credential is minted", () => {
    const resolver = makeResolver();
    const json = JSON.stringify(resolver);
    expect(json).toBe('{"mode":"vended-direct"}');
  });

  it("never leaks a minted credential through JSON.stringify", async () => {
    const resolver = makeResolver();
    const creds = await resolver.getCredentials();
    expect(creds.secretAccessKey).toBe("SECRETACCESSKEY-x9"); // it IS held...
    const json = JSON.stringify(resolver);
    for (const secret of SECRETS) {
      expect(json).not.toContain(secret); // ...but never serializable
    }
  });

  it("never leaks through enumeration either (structured loggers walk objects)", async () => {
    const resolver = makeResolver();
    await resolver.getCredentials();
    const walk = (value: unknown, seen = new Set<unknown>()): string[] => {
      if (typeof value !== "object" || value === null || seen.has(value)) return [];
      seen.add(value);
      const out: string[] = [];
      for (const key of Object.keys(value)) {
        const v = (value as Record<string, unknown>)[key];
        if (typeof v === "string") out.push(v);
        else out.push(...walk(v, seen));
      }
      return out;
    };
    const strings = walk(resolver);
    for (const secret of SECRETS) {
      expect(strings).not.toContain(secret);
    }
  });

  it("getMqttSpec builds the tenant-scoped topic and an xgl- client id from the vend response", async () => {
    const resolver = makeResolver();
    const spec = await resolver.getMqttSpec("dev-1");
    expect(spec.clientId.startsWith("xgl-")).toBe(true);
    expect(spec.topics).toEqual(["xorgate/orgs/org-1/ws/ws-1/devices/dev-1/telemetry"]);
    expect(spec.region).toBe("us-east-1");
    expect(spec.endpoint).toBe("x-ats.iot.us-east-1.amazonaws.com");
  });

  it("caches a fresh credential and single-flights concurrent mints", async () => {
    let mints = 0;
    const auth: XorgateAuth = {
      getLiveCredentials: async () => {
        mints++;
        return {
          accessKeyId: "AK",
          secretAccessKey: "SK",
          expiration: new Date(Date.now() + 3_600_000).toISOString(),
        };
      },
    };
    const resolver = new LiveCredentialResolver({
      getAuth: () => auth,
      getConfig: () => ({ baseUrl: "https://api.xorgate.io" }),
      getRest: () => ({ kind: "no-organization" }),
      getTenancy: () => ({ organizationId: null, workspaceId: undefined }),
    });
    await Promise.all([resolver.getCredentials(), resolver.getCredentials()]);
    await resolver.getCredentials();
    expect(mints).toBe(1);
    resolver.invalidate();
    await resolver.getCredentials();
    expect(mints).toBe(2);
  });

  it("an expired cached credential is re-minted", async () => {
    let mints = 0;
    const auth: XorgateAuth = {
      getLiveCredentials: async () => {
        mints++;
        // Expires inside the 5-minute refresh margin.
        return {
          accessKeyId: "AK",
          secretAccessKey: "SK",
          expiration: new Date(Date.now() + 60_000).toISOString(),
        };
      },
    };
    const resolver = new LiveCredentialResolver({
      getAuth: () => auth,
      getConfig: () => ({ baseUrl: "https://api.xorgate.io" }),
      getRest: () => ({ kind: "no-organization" }),
      getTenancy: () => ({ organizationId: null, workspaceId: undefined }),
    });
    await resolver.getCredentials();
    await resolver.getCredentials();
    expect(mints).toBe(2);
  });
});

describe("availability", () => {
  it("api-key-only auth has no live plane", () => {
    const resolver = new LiveCredentialResolver({
      getAuth: () => ({ apiKey: "xg_x" }),
      getConfig: () => ({ baseUrl: "https://api.xorgate.io" }),
      getRest: () => ({ kind: "no-organization" }),
      getTenancy: () => ({ organizationId: null, workspaceId: undefined }),
    });
    expect(resolver.availability()).toEqual({ available: false, reason: "no-live-credentials" });
  });

  it("first-party auth without the AWS config is not-configured", () => {
    const resolver = new LiveCredentialResolver({
      getAuth: () => ({ getIdToken: () => "id-token" }),
      getConfig: () => ({ baseUrl: "https://api.xorgate.io" }),
      getRest: () => ({ kind: "no-organization" }),
      getTenancy: () => ({ organizationId: null, workspaceId: undefined }),
    });
    expect(resolver.availability()).toEqual({ available: false, reason: "not-configured" });
  });

  it("first-party auth with region+pools is available; telemetry additionally needs the endpoint", () => {
    const base = {
      region: "us-east-1",
      identityPoolId: "us-east-1:pool",
      userPoolId: "us-east-1_ABC",
    };
    let config: Record<string, string> = { baseUrl: "https://api.xorgate.io", ...base };
    const resolver = new LiveCredentialResolver({
      getAuth: () => ({ getIdToken: () => "id-token" }),
      getConfig: () => config as never,
      getRest: () => ({ kind: "no-organization" }),
      getTenancy: () => ({ organizationId: null, workspaceId: undefined }),
    });
    expect(resolver.availability().available).toBe(true);
    expect(resolver.telemetryAvailability()).toEqual({
      available: false,
      reason: "not-configured",
    });
    config = { ...config, realtimeEndpoint: "x-ats.iot.us-east-1.amazonaws.com" };
    expect(resolver.telemetryAvailability().available).toBe(true);
  });
});
