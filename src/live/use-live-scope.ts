import { useCallback } from "react";
import { useXorgateContext } from "../context.js";

export interface UseLiveScope {
  /** The organization the current live credential was vended for, or the provider's. */
  organizationId: string | null;
  /**
   * The workspace the current live credential is confined to. **Null means the
   * credential is not workspace-scoped** (or nothing has been vended yet), not
   * that it has no workspace.
   */
  workspaceId: string | null;
  /**
   * Throw the live credential away, forget everything learned from the last
   * vend, and make every live consumer re-resolve NOW.
   *
   * Call it whenever a device's tenancy changes under you — after
   * `devices.transfer()`, after `transferOffers.accept()`, and after a
   * workspace switch that re-vends. Without it a viewer keeps the old scope for
   * up to about 50 minutes, during which live telemetry is silently EMPTY (the
   * subscription names a topic the device no longer publishes on) and live
   * video starts failing once the KVS channel is re-tagged.
   *
   * ```tsx
   * const { invalidate } = useLiveScope()
   * const onTransfer = async () => {
   *   await xg.devices.transfer(deviceId, { workspaceId })
   *   invalidate()
   * }
   * ```
   *
   * Cheap and idempotent: it costs one credential mint on the next resolve.
   */
  invalidate: () => void;
}

/**
 * The tenancy the LIVE plane is currently operating in, and the way to reset it.
 *
 * This is deliberately not the same thing as `useXorgateTenancy()`. That one
 * reports the provider's props, which is what REST requests are sent with. This
 * one reports what the live credential was actually vended for, which is what
 * the MQTT topic filter and the KVS tag condition are checked against — and the
 * two drift apart for exactly as long as a cached credential lives.
 */
export function useLiveScope(): UseLiveScope {
  const { live } = useXorgateContext();
  const scope = live.scope();
  const invalidate = useCallback(() => live.invalidateScope(), [live]);
  return { ...scope, invalidate };
}
