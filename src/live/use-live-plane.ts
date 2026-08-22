import { useXorgateContext } from "../context.js";
import type { LiveUnavailableReason } from "../config.js";

/**
 * Ask once, at the top of a page, instead of reading `unavailableReason` off
 * three different hooks. `available` is about credentials and config only; a
 * specific device can still be `"not-provisioned"`.
 */
export function useLivePlane(): {
  available: boolean;
  reason: LiveUnavailableReason | null;
} {
  const { live } = useXorgateContext();
  return live.availability();
}
