import { useEffect, useRef, useState } from "react";
import type { VideoChannel, XorgateError } from "@xorgate/sdk";
import { useXorgateContext } from "../context.js";
import type { LiveUnavailableReason } from "../config.js";
import { browserSubscribeWake } from "../platform.js";
import { KvsViewerSession } from "./kvs-session.js";
import type { LiveVideoStats, LiveVideoStatus } from "./kvs-session.js";
import { createWebRtcPlatform } from "./webrtc-platform.js";

export interface UseLiveVideoSession {
  status: LiveVideoStatus;
  unavailableReason: LiveUnavailableReason | null;
  error: XorgateError | null;
  /** Null until the first sample lands. Reset to null on every reconnect. */
  stats: LiveVideoStats | null;
}

export interface UseLiveVideoSessionOptions {
  /**
   * The received remote stream, on EVERY track event: a reconnect delivers a
   * new stream and the old one is dead. A browser attaches it as `srcObject`;
   * React Native hands `stream.toURL()` to an `RTCView`.
   */
  onStream: (stream: unknown) => void;
  /** Default true. False tears the session down without unmounting. */
  enabled?: boolean;
  /** inbound-rtp sampling period, and therefore the bitrate averaging window. Default 2000. */
  statsIntervalMs?: number;
}

/**
 * The platform-neutral core of `useLiveVideo`: runs the KVS WebRTC VIEWER
 * session for one channel over the provider's platform (or the browser's)
 * and reports status/error/stats. It knows nothing about video elements;
 * `onStream` is where the platform wrapper attaches the picture. The
 * platform's `subscribeWake` (foreground, network back) nudges a session out
 * of its backoff, exactly as the browser's visibility events did.
 */
export function useLiveVideoSession(
  channel: VideoChannel | null,
  options: UseLiveVideoSessionOptions,
): UseLiveVideoSession {
  const { live, platform } = useXorgateContext();
  const [status, setStatus] = useState<LiveVideoStatus>("connecting");
  const [unavailableReason, setUnavailableReason] = useState<LiveUnavailableReason | null>(null);
  const [error, setError] = useState<XorgateError | null>(null);
  const [stats, setStats] = useState<LiveVideoStats | null>(null);

  const enabled = options.enabled !== false;
  const statsIntervalMs = options.statsIntervalMs;
  // Latest-ref: an inline `onStream` must not bounce the session.
  const onStreamRef = useRef(options.onStream);
  onStreamRef.current = options.onStream;

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
      platform: (platform.createWebRtcPlatform ?? createWebRtcPlatform)(),
      ...(statsIntervalMs !== undefined ? { statsIntervalMs } : {}),
      callbacks: {
        onStatus: (s, err) => {
          setStatus(s);
          setError(err);
        },
        onStats: setStats,
        onStream: (stream) => onStreamRef.current(stream),
      },
    });
    session.start();

    // A backgrounded app's peer connection is usually dead by the time the
    // user returns; start fresh instead of waiting out a stale backoff.
    const unsubscribeWake = (platform.subscribeWake ?? browserSubscribeWake)(() =>
      session.nudge(),
    );

    return () => {
      unsubscribeWake();
      session.destroy();
      setStatus("connecting");
      setError(null);
      setStats(null);
    };
    // Channel identity is (channelRef, region); an inline channel object must
    // not bounce the session. `platform` is stable for a provider's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, channel?.channelRef, channel?.region, enabled, statsIntervalMs]);

  return { status, unavailableReason, error, stats };
}
