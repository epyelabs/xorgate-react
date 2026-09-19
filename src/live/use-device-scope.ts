import { useCallback, useEffect, useRef, useState } from "react";
import { XorgateError } from "@xorgate/sdk";
import type { Device } from "@xorgate/sdk";
import { useXorgateContext } from "../context.js";
import { useDevice } from "../query/hooks.js";
import type { QueryOptions } from "../query/use-query.js";

/**
 * - `checking` — the device has not been read yet.
 * - `in-scope` — the live credential covers the workspace the device is in.
 * - `out-of-scope` — it does not, and a re-vend did not fix it. `error` is set.
 * - `unknown` — cannot be decided: an organization-scoped credential (which may
 *   reach any workspace in its organization, and this SDK does not know which
 *   those are), a first-party Cognito session, an auth mode with no REST plane,
 *   or a device read that failed for some other reason. **Not a problem
 *   signal.** Carry on.
 */
export type DeviceScopeStatus = "checking" | "in-scope" | "out-of-scope" | "unknown";

export interface UseDeviceScope {
  status: DeviceScopeStatus;
  /** True exactly when `status === "out-of-scope"`. The one-liner for gating a live hook. */
  outOfScope: boolean;
  /** `DEVICE_OUT_OF_SCOPE`, or null. Set only in the `out-of-scope` state. */
  error: XorgateError | null;
  /** The device as REST sees it, once read. */
  device: Device | undefined;
  /** Whatever the device read failed with, if it did. Distinct from `error`. */
  deviceError: XorgateError | null;
  /** Re-read the device and re-compare. */
  recheck: () => Promise<void>;
}

export interface UseDeviceScopeOptions extends QueryOptions {}

/**
 * Turn a device that has been transferred out from under a live viewer into a
 * typed error instead of a blank pane.
 *
 * ## Why this exists
 *
 * A vended live credential encodes org + workspace in its session policy, and
 * `@xorgate/react` caches it until close to expiry — up to about 50 minutes.
 * When a device is transferred inside that window, nothing fails loudly:
 *
 * - **Telemetry goes silent.** The subscription targets
 *   `xorgate/orgs/{org}/ws/{ws}/devices/{id}/telemetry` with the old ids spelled
 *   out; the device now publishes under different ones. The socket stays
 *   `connected` and no frame ever arrives, which is indistinguishable from an
 *   idle device.
 * - **Video keeps working, then stops.** KVS authorizes on a resource tag with
 *   no MQTT session involved, so an established session flows until it is
 *   cycled and the next connect gets `AccessDenied`.
 *
 * That silence is the single worst outcome here, and it is exactly what a
 * third-party consumer saw on 2026-09-18. Note that it is invisible in
 * `console.xorgate.io`, which subscribes to BOTH telemetry planes with
 * wildcards: a first-party console renders a transferred device perfectly while
 * a workspace-scoped consumer of the same device sees nothing.
 *
 * ## What it does
 *
 * Reads the device over REST and compares its `workspaceId` against the
 * workspace the live credential was vended for.
 *
 * - A device the REST plane answers `NOT_FOUND` for is **out of scope**: it was
 *   transferred to another organization. (The API answers 404 rather than 403
 *   on purpose — confirming another tenant's resource exists is itself a leak —
 *   so 404 here means "not yours", not "deleted".)
 * - A workspace mismatch **re-vends once** (`invalidateScope()`), because the
 *   ordinary case is simply a stale cached credential and a fresh one fixes it
 *   silently. If the mismatch survives the re-vend it fails loudly with
 *   `DEVICE_OUT_OF_SCOPE`.
 * - Anything it cannot decide is `unknown`, never a false alarm.
 *
 * ## Using it
 *
 * ```tsx
 * const scope = useDeviceScope(deviceId)
 * const live = useLiveTelemetry(scope.outOfScope ? null : deviceId)
 *
 * if (scope.error) return <Banner>{scope.error.message}</Banner>
 * ```
 *
 * Pass `refetchIntervalMs` to keep checking; one read on mount is the default,
 * which catches the case that matters (a viewer opened on a device that has
 * already moved). Nothing here polls on its own.
 */
export function useDeviceScope(
  deviceId: string | null,
  options: UseDeviceScopeOptions = {},
): UseDeviceScope {
  const { live, rest } = useXorgateContext();
  const enabled = options.enabled !== false && deviceId !== null;
  const query = useDevice(deviceId, options);

  const [state, setState] = useState<{
    status: DeviceScopeStatus;
    error: XorgateError | null;
  }>({ status: "checking", error: null });

  // One re-vend per (device, workspace) pair. Without the guard a credential
  // that genuinely cannot see the device would re-vend on every render.
  const revended = useRef<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    revended.current = null;
    setState({ status: "checking", error: null });
  }, [deviceId]);

  useEffect(() => {
    if (!enabled) {
      setState({ status: "unknown", error: null });
      return;
    }
    // Modes with no workspace-scoped credential to compare against: first-party
    // Cognito (the console subscribes to both telemetry planes with wildcards)
    // and no live plane at all. Say `unknown` WITHOUT minting anything.
    const mode = live.mode();
    if (mode !== "vended-direct" && mode !== "vended-token") {
      setState({ status: "unknown", error: null });
      return;
    }
    // No REST plane (a `{ getLiveCredentials }`-only consumer). There is
    // nothing to compare against; say so rather than guessing.
    if (rest.kind === "no-credential") {
      setState({ status: "unknown", error: null });
      return;
    }
    if (query.error) {
      // 404 means "not reachable by this credential", not "deleted": the API
      // answers 404 rather than 403 for another tenant's resource on purpose,
      // because confirming it exists is itself a leak.
      setState(
        query.error.code === "NOT_FOUND"
          ? { status: "out-of-scope", error: outOfScopeError(deviceId!, null) }
          : { status: "unknown", error: null },
      );
      return;
    }
    const device = query.data;
    if (!device) {
      setState({ status: "checking", error: null });
      return;
    }

    let cancelled = false;
    void (async () => {
      // Make sure SOMETHING has been vended: the scope is learned from a vend
      // response, and this is cached and single-flighted, so it costs nothing
      // when a live hook has already resolved.
      try {
        await live.getCredentials();
      } catch {
        // A credential failure is not a scope verdict. The live hooks report it
        // in their own `error`; this hook must not claim the device moved.
        if (!cancelled && alive.current) setState({ status: "unknown", error: null });
        return;
      }
      if (cancelled || !alive.current) return;

      const covered = live.coversWorkspace(device.workspaceId);
      if (covered === null) {
        setState({ status: "unknown", error: null });
        return;
      }
      if (covered) {
        setState({ status: "in-scope", error: null });
        return;
      }

      // Mismatch. Re-vend ONCE — the usual cause is a credential cached across
      // the transfer, and a fresh one resolves it with nobody the wiser. The
      // guard is what stops a credential that genuinely cannot see the device
      // re-vending on every render.
      const key = `${device.id}:${device.workspaceId}`;
      if (revended.current === key) {
        setState({
          status: "out-of-scope",
          error: outOfScopeError(device.id, device.workspaceId),
        });
        return;
      }
      revended.current = key;
      setState({ status: "checking", error: null });
      live.invalidateScope();
      try {
        await live.getCredentials();
      } catch {
        if (!cancelled && alive.current) setState({ status: "unknown", error: null });
        return;
      }
      if (cancelled || !alive.current) return;
      const after = live.coversWorkspace(device.workspaceId);
      setState(
        after === false
          ? { status: "out-of-scope", error: outOfScopeError(device.id, device.workspaceId) }
          : { status: after === true ? "in-scope" : "unknown", error: null },
      );
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled, rest.kind, query.data, query.error, live, deviceId]);

  const recheck = useCallback(async () => {
    revended.current = null;
    await query.refetch();
  }, [query]);

  return {
    status: state.status,
    outOfScope: state.status === "out-of-scope",
    error: state.error,
    device: query.data,
    deviceError: query.error,
    recheck,
  };
}

function outOfScopeError(deviceId: string, workspaceId: string | null): XorgateError {
  return new XorgateError({
    code: "DEVICE_OUT_OF_SCOPE",
    message:
      workspaceId === null
        ? `Device "${deviceId}" is not reachable with this credential: it has been ` +
          "transferred to another organization, or deleted. The API answers 404 for " +
          "both, deliberately."
        : `Device "${deviceId}" is in workspace "${workspaceId}", which this live ` +
          "credential does not cover. It was transferred, and re-vending did not help — " +
          "the credential's own workspace no longer holds the device.",
    details: { deviceId, ...(workspaceId !== null ? { workspaceId } : {}) },
  });
}
