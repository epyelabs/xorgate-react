import type { WebRtcPlatform } from "./live/kvs-session.js";
import type { MqttLikeClient } from "./live/telemetry-feed.js";
import type { MqttConnectionSpec } from "./live/credential-resolver.js";

/**
 * The platform slot. Everything in `@xorgate/react` that touches the host
 * runtime (WebRTC, the WebSocket the MQTT client rides, wake-up events, id
 * entropy) goes through one of these five optional functions, and every one
 * of them defaults to the browser implementation, so a web consumer never
 * passes a `platform` at all.
 *
 * `@xorgate/react-native` supplies the React Native adapters as one object:
 * `<XorgateProvider platform={nativePlatform()}>`. The slot is read lazily
 * at the point of use, so a page that mounts no video still pulls no WebRTC
 * or AWS code (see `scripts/check-bundle.mjs`).
 */
export interface XorgatePlatform {
  /**
   * The real AWS wiring for the KVS viewer session. Default: the browser
   * implementation over the global `RTCPeerConnection`.
   */
  createWebRtcPlatform?: () => WebRtcPlatform;
  /**
   * Fires when the app comes back to the foreground or the network returns.
   * The live feeds skip their backoff and reconnect NOW; the data hooks with
   * `refetchOnFocus` refetch. Default: `visibilitychange`, `pageshow` and
   * `online` on the browser's window/document.
   */
  subscribeWake?: (onWake: () => void) => () => void;
  /**
   * The MQTT connection factory. Default: a dynamic `import("mqtt")` over the
   * global `WebSocket`, with the presigned URL forced through untouched.
   */
  mqttConnect?: (url: string, spec: MqttConnectionSpec) => Promise<MqttLikeClient>;
  /**
   * Client-id entropy for MQTT and signaling. Default: `crypto.randomUUID()`.
   * React Native has no `crypto` global; the native platform uses expo-crypto.
   */
  randomId?: () => string;
}

/** The browser wake sources: the tab becomes visible, the page is restored, the network returns. */
export function browserSubscribeWake(onWake: () => void): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") return () => undefined;
  const handler = () => {
    if (document.visibilityState !== "visible") return;
    onWake();
  };
  window.addEventListener("online", handler);
  window.addEventListener("pageshow", handler);
  document.addEventListener("visibilitychange", handler);
  return () => {
    window.removeEventListener("online", handler);
    window.removeEventListener("pageshow", handler);
    document.removeEventListener("visibilitychange", handler);
  };
}

/** `crypto.randomUUID()`, with a message that names the platform slot when the runtime has no `crypto`. */
export function browserRandomId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (!c || typeof c.randomUUID !== "function") {
    throw new Error(
      "This runtime has no crypto.randomUUID(). Pass a `platform` with `randomId` to " +
        "<XorgateProvider> (React Native: @xorgate/react-native's nativePlatform()).",
    );
  }
  return c.randomUUID();
}

/**
 * Today's browser behaviour as one object, for consumers that want to spread
 * over it. `XorgateProvider` does NOT call this: it resolves each slot at
 * its point of use so the WebRTC and MQTT code stays behind dynamic imports.
 */
export function browserPlatform(): Required<Pick<XorgatePlatform, "subscribeWake" | "randomId">> {
  return { subscribeWake: browserSubscribeWake, randomId: browserRandomId };
}

/** The platform read by every consumer: the provider's prop, or nothing. */
export const EMPTY_PLATFORM: XorgatePlatform = Object.freeze({});
