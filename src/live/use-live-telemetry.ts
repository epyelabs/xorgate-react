import { useEffect, useState } from "react";
import { useXorgateContext } from "../context.js";
import { acquireFeed, releaseFeed } from "./telemetry-feed.js";
import type { TelemetrySnapshot } from "./telemetry-feed.js";

export interface UseLiveTelemetryOptions {
  /** Default true. False releases the shared feed without unmounting. */
  enabled?: boolean;
  /** Ring-buffer size. Default 300, about five minutes at the device's 1 Hz. */
  historyLimit?: number;
  /** Coalescing window. Default 250, so a 1 Hz × N-metric feed costs at most 4 renders/s. */
  flushMs?: number;
}

export type UseLiveTelemetry = TelemetrySnapshot;

const IDLE: TelemetrySnapshot = {
  latest: {},
  history: [],
  recording: null,
  media: null,
  receivedAt: null,
  status: "connecting",
  unavailableReason: null,
  error: null,
};

/**
 * Subscribe to a device's live telemetry over MQTT-over-WSS. All simultaneous
 * consumers of the same device share ONE socket, ref-counted at module scope;
 * mount this hook freely. The subscription is QoS 0 and nothing is retained:
 * frames published before the subscription completes are lost by design, so
 * seed a chart from `client.telemetry.recent()` if you need the preceding
 * minutes.
 */
export function useLiveTelemetry(
  deviceId: string | null,
  options: UseLiveTelemetryOptions = {},
): UseLiveTelemetry {
  const { live, platform } = useXorgateContext();
  const enabled = options.enabled !== false;
  const { historyLimit, flushMs } = options;

  const [snap, setSnap] = useState<TelemetrySnapshot>(IDLE);

  useEffect(() => {
    if (!deviceId || !enabled) {
      setSnap(IDLE);
      return;
    }
    // The platform slots ride along on first acquisition; later mounters
    // share the same feed (a provider's platform is stable for its life).
    const feed = acquireFeed(live, deviceId, {
      ...(platform.mqttConnect ? { connect: platform.mqttConnect } : {}),
      ...(platform.subscribeWake ? { subscribeWake: platform.subscribeWake } : {}),
    });
    feed.tune({
      ...(historyLimit !== undefined ? { historyLimit } : {}),
      ...(flushMs !== undefined ? { flushMs } : {}),
    });
    setSnap(feed.snapshot());
    const unsubscribe = feed.subscribe(() => setSnap(feed.snapshot()));
    return () => {
      unsubscribe();
      releaseFeed(live, deviceId, feed);
    };
    // `platform` is read once per feed; a provider does not change it mid-life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, deviceId, enabled, historyLimit, flushMs]);

  return snap;
}
