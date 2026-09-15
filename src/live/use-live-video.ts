import { useCallback, useEffect, useRef } from "react";
import type { RefObject } from "react";
import type { VideoChannel, XorgateError } from "@xorgate/sdk";
import type { LiveUnavailableReason } from "../config.js";
import type { LiveVideoStats, LiveVideoStatus } from "./kvs-session.js";
import { useLiveVideoSession } from "./use-live-video-session.js";

export type { LiveVideoStatus, LiveVideoStats } from "./kvs-session.js";

export interface UseLiveVideo {
  /** Attach to a `<video playsInline muted>`. The hook sets `srcObject`, you own the element. */
  videoRef: RefObject<HTMLVideoElement | null>;
  status: LiveVideoStatus;
  unavailableReason: LiveUnavailableReason | null;
  error: XorgateError | null;
  /** Null until the first sample lands. Reset to null on every reconnect. */
  stats: LiveVideoStats | null;
}

export interface UseLiveVideoOptions {
  /** Default true. False tears the session down without unmounting the component. */
  enabled?: boolean;
  /** inbound-rtp sampling period, and therefore the bitrate averaging window. Default 2000. */
  statsIntervalMs?: number;
}

/**
 * Run a KVS WebRTC VIEWER for one signaling channel and attach the received
 * `MediaStream` to `videoRef`. Pass `null` to stay idle.
 *
 * The reconnect machinery (generation counter, per-step and whole-attempt
 * deadlines, disconnect grace, backoff, ~50 minute credential cycle,
 * visibility nudges) was all earned against real LTE devices; see the docs
 * page for what each piece answers. A reconnect deliberately does NOT clear
 * the `<video>` element, so the last frame stays on screen instead of flashing
 * to black.
 *
 * This is the browser wrapper over `useLiveVideoSession`; React Native
 * consumers use `@xorgate/react-native`'s `useLiveVideo`, which renders the
 * same session into an `RTCView`.
 */
export function useLiveVideo(
  channel: VideoChannel | null,
  options: UseLiveVideoOptions = {},
): UseLiveVideo {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Always (re)attach the incoming stream: on a reconnect the previous
  // srcObject points at a dead stream, and only attaching when empty would
  // leave the element frozen on the last frame.
  const onStream = useCallback((stream: unknown) => {
    const video = videoRef.current;
    if (video && video.srcObject !== stream) {
      video.srcObject = stream as MediaProvider;
    }
  }, []);

  const session = useLiveVideoSession(channel, {
    onStream,
    ...(options.enabled !== undefined ? { enabled: options.enabled } : {}),
    ...(options.statsIntervalMs !== undefined ? { statsIntervalMs: options.statsIntervalMs } : {}),
  });

  // Clear the element when the session goes away (channel change, disable,
  // unmount), never on a reconnect.
  const active = channel !== null && options.enabled !== false;
  useEffect(() => {
    if (!active) return;
    return () => {
      if (videoRef.current) videoRef.current.srcObject = null;
    };
  }, [active, channel?.channelRef, channel?.region]);

  return { videoRef, ...session };
}
