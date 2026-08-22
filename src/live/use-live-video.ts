import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { VideoChannel, XorgateError } from "@xorgate/sdk";
import { useXorgateContext } from "../context.js";
import type { LiveUnavailableReason } from "../config.js";
import { KvsViewerSession } from "./kvs-session.js";
import type { LiveVideoStats, LiveVideoStatus } from "./kvs-session.js";
import { createWebRtcPlatform } from "./webrtc-platform.js";

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
 */
export function useLiveVideo(
  channel: VideoChannel | null,
  options: UseLiveVideoOptions = {},
): UseLiveVideo {
  const { live } = useXorgateContext();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [status, setStatus] = useState<LiveVideoStatus>("connecting");
  const [unavailableReason, setUnavailableReason] = useState<LiveUnavailableReason | null>(null);
  const [error, setError] = useState<XorgateError | null>(null);
  const [stats, setStats] = useState<LiveVideoStats | null>(null);

  const enabled = options.enabled !== false;
  const statsIntervalMs = options.statsIntervalMs;

  useEffect(() => {
    if (!channel || !enabled) return;

    const availability = live.availability();
    if (!availability.available) {
      setStatus("unavailable");
      setUnavailableReason(availability.reason);
      return;
    }
    setUnavailableReason(null);

    const session = new KvsViewerSession({
      channelRef: channel.channelRef,
      region: channel.region || undefined,
      resolver: live,
      platform: createWebRtcPlatform(),
      ...(statsIntervalMs !== undefined ? { statsIntervalMs } : {}),
      callbacks: {
        onStatus: (s, err) => {
          setStatus(s);
          setError(err);
        },
        onStats: setStats,
        onStream: (stream) => {
          const video = videoRef.current;
          if (video && video.srcObject !== stream) {
            video.srcObject = stream as MediaProvider;
          }
        },
      },
    });
    session.start();

    // Mobile browsers freeze background tabs; when the page becomes visible
    // (or the network returns), start fresh instead of waiting out a stale
    // backoff.
    const nudge = () => {
      if (document.visibilityState !== "visible") return;
      session.nudge();
    };
    window.addEventListener("online", nudge);
    window.addEventListener("pageshow", nudge);
    document.addEventListener("visibilitychange", nudge);

    return () => {
      window.removeEventListener("online", nudge);
      window.removeEventListener("pageshow", nudge);
      document.removeEventListener("visibilitychange", nudge);
      session.destroy();
      if (videoRef.current) videoRef.current.srcObject = null;
      setStatus("connecting");
      setError(null);
      setStats(null);
    };
    // Channel identity is (channelRef, region); an inline channel object must
    // not bounce the session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, channel?.channelRef, channel?.region, enabled, statsIntervalMs]);

  return { videoRef, status, unavailableReason, error, stats };
}
