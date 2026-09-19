// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { XorgateProvider } from "../src/context.js";
import { useDeviceScope } from "../src/live/use-device-scope.js";
import { useLiveScope } from "../src/live/use-live-scope.js";

/**
 * `useDeviceScope` — turning a transferred-away device into a typed error
 * instead of a blank pane.
 *
 * The failure it guards against produces no error of its own: the MQTT socket
 * stays connected to a topic the device no longer publishes on, so a consumer
 * sees an empty feed that is indistinguishable from an idle device. That is
 * exactly what a third-party consumer saw on 2026-09-18 while the first-party
 * console — which subscribes to BOTH telemetry planes with wildcards — rendered
 * the same device perfectly.
 */

const ORG = "org-1";

function deviceRow(workspaceId: string) {
  return {
    id: "dev-1",
    workspaceId,
    deviceModelId: "dm-1",
    serial: "XG-1",
    name: "Excavator",
    agentVersion: "v0.0.6",
    status: "online",
    lastSeenAt: null,
    config: {},
    configRev: 1,
    configUpdatedAt: null,
    uiPrefs: {},
    reportedConfig: null,
    reportedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

/** A fetch that answers `GET /devices/{id}` and 404s anything unexpected. */
function restStub(replies: Array<{ status: number; body: unknown }>) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)]!;
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function wrapper(options: {
  vendWorkspaceId: string | undefined;
  fetchImpl: typeof fetch;
  onVend?: () => void;
}) {
  const vend = async () => {
    options.onVend?.();
    return {
      accessKeyId: "AK",
      secretAccessKey: "SK",
      sessionToken: "ST",
      expiration: new Date(Date.now() + 3_600_000).toISOString(),
      organizationId: ORG,
      ...(options.vendWorkspaceId !== undefined
        ? { workspaceId: options.vendWorkspaceId }
        : {}),
      live: {
        region: "us-east-1",
        realtimeEndpoint: "example-ats.iot.us-east-1.amazonaws.com",
      },
    };
  };
  return ({ children }: { children: ReactNode }) =>
    createElement(XorgateProvider, {
      auth: { apiKey: "xg_test", getLiveCredentials: vend },
      organizationId: ORG,
      config: { baseUrl: "https://api.example.test", fetch: options.fetchImpl },
      children,
    });
}

describe("useDeviceScope", () => {
  it("reports in-scope when the credential covers the device's workspace", async () => {
    const { fetchImpl } = restStub([{ status: 200, body: { device: deviceRow("ws-1") } }]);
    const { result } = renderHook(() => useDeviceScope("dev-1"), {
      wrapper: wrapper({ vendWorkspaceId: "ws-1", fetchImpl }),
    });
    await waitFor(() => expect(result.current.status).toBe("in-scope"));
    expect(result.current.outOfScope).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("re-vends ONCE on a mismatch, and stays quiet when that fixes it", async () => {
    // The ordinary case: the credential was cached across the transfer and a
    // fresh one is simply correct. Nobody should see an error for that.
    let vendWorkspace = "ws-1";
    const vends = vi.fn();
    const { fetchImpl } = restStub([{ status: 200, body: { device: deviceRow("ws-2") } }]);
    const wrap = ({ children }: { children: ReactNode }) =>
      createElement(XorgateProvider, {
        auth: {
          apiKey: "xg_test",
          getLiveCredentials: async () => {
            vends();
            return {
              accessKeyId: "AK",
              secretAccessKey: "SK",
              sessionToken: "ST",
              expiration: new Date(Date.now() + 3_600_000).toISOString(),
              organizationId: ORG,
              workspaceId: vendWorkspace,
              live: {
                region: "us-east-1",
                realtimeEndpoint: "example-ats.iot.us-east-1.amazonaws.com",
              },
            };
          },
        },
        organizationId: ORG,
        config: { baseUrl: "https://api.example.test", fetch: fetchImpl },
        children,
      });

    const { result } = renderHook(() => useDeviceScope("dev-1"), { wrapper: wrap });
    // The first mismatch triggers the re-vend; by then the vend answers ws-2.
    vendWorkspace = "ws-2";
    await waitFor(() => expect(result.current.status).toBe("in-scope"));
    expect(result.current.error).toBeNull();
    expect(vends).toHaveBeenCalled();
  });

  it("fails loudly with DEVICE_OUT_OF_SCOPE when the re-vend does not help", async () => {
    const { fetchImpl } = restStub([{ status: 200, body: { device: deviceRow("ws-2") } }]);
    const { result } = renderHook(() => useDeviceScope("dev-1"), {
      wrapper: wrapper({ vendWorkspaceId: "ws-1", fetchImpl }),
    });
    await waitFor(() => expect(result.current.status).toBe("out-of-scope"));
    expect(result.current.outOfScope).toBe(true);
    expect(result.current.error?.code).toBe("DEVICE_OUT_OF_SCOPE");
    expect(result.current.error?.details).toMatchObject({
      deviceId: "dev-1",
      workspaceId: "ws-2",
    });
  });

  it("treats a 404 on the device as out-of-scope: it moved to another organization", async () => {
    // The API answers 404 rather than 403 on purpose — confirming another
    // tenant's resource exists is itself a leak — so 404 means "not yours".
    const { fetchImpl } = restStub([
      { status: 404, body: { error: { code: "NOT_FOUND", message: "Device not found" } } },
    ]);
    const { result } = renderHook(() => useDeviceScope("dev-1"), {
      wrapper: wrapper({ vendWorkspaceId: "ws-1", fetchImpl }),
    });
    await waitFor(() => expect(result.current.status).toBe("out-of-scope"));
    expect(result.current.error?.code).toBe("DEVICE_OUT_OF_SCOPE");
    expect(result.current.error?.details).not.toHaveProperty("workspaceId");
  });

  it("an organization-scoped credential is `unknown`, never a false alarm", async () => {
    const { fetchImpl } = restStub([{ status: 200, body: { device: deviceRow("ws-7") } }]);
    const { result } = renderHook(() => useDeviceScope("dev-1"), {
      wrapper: wrapper({ vendWorkspaceId: undefined, fetchImpl }),
    });
    await waitFor(() => expect(result.current.status).toBe("unknown"));
    expect(result.current.outOfScope).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("a null deviceId stays idle and makes no request", async () => {
    const { fetchImpl, calls } = restStub([{ status: 200, body: { device: deviceRow("ws-1") } }]);
    const { result } = renderHook(() => useDeviceScope(null), {
      wrapper: wrapper({ vendWorkspaceId: "ws-1", fetchImpl }),
    });
    await waitFor(() => expect(result.current.status).toBe("unknown"));
    expect(calls).toEqual([]);
  });

  it("a non-404 device error is `unknown`, and is surfaced separately", async () => {
    const { fetchImpl } = restStub([
      { status: 500, body: { error: { code: "SERVER_ERROR", message: "boom" } } },
    ]);
    const { result } = renderHook(() => useDeviceScope("dev-1"), {
      wrapper: wrapper({ vendWorkspaceId: "ws-1", fetchImpl }),
    });
    await waitFor(() => expect(result.current.deviceError?.code).toBe("SERVER_ERROR"));
    expect(result.current.status).toBe("unknown");
    expect(result.current.error).toBeNull();
  });
});

describe("useLiveScope", () => {
  it("reports the vended tenancy and exposes invalidate()", async () => {
    const { fetchImpl } = restStub([{ status: 200, body: { device: deviceRow("ws-1") } }]);
    const { result } = renderHook(
      () => {
        const scope = useLiveScope();
        // Mounting the guard is what drives the first vend.
        useDeviceScope("dev-1");
        return scope;
      },
      { wrapper: wrapper({ vendWorkspaceId: "ws-1", fetchImpl }) },
    );
    await waitFor(() => expect(result.current.workspaceId).toBe("ws-1"));
    expect(result.current.organizationId).toBe(ORG);
    expect(typeof result.current.invalidate).toBe("function");
  });
});
