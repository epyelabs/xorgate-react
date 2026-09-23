/**
 * The e2e test application. It consumes `@xorgate/react` exactly as Alocate
 * will: the PROXIED profile. The xorgate API key lives only in the harness
 * server; this page receives vended live credentials, a replay manifest
 * OBJECT fetched server-side, and proxies telemetry history through the
 * harness — the browser touches no xorgate REST endpoint. When the manifest
 * carries its `telemetry` block the hook reads the presigned artifacts
 * straight from S3 and the proxy is never called; that is what step 3 of
 * `run.mjs` asserts in both directions.
 */
import { StrictMode, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import {
  XorgateProvider,
  useLiveTelemetry,
  useLiveVideo,
  useReplayPlayer,
  useReplayTelemetry,
  ReplayVideo,
  type LiveCredentials,
  type ReplayManifest,
  type TelemetryHistory,
  type UseReplayPlayer,
  type VideoChannel,
} from "@xorgate/react";

declare global {
  interface Window {
    __TEST: {
      test: "live-telemetry" | "live-video" | "replay";
      deviceId: string;
      organizationId: string;
      channel?: VideoChannel;
      manifest?: ReplayManifest;
      metrics?: string[];
    };
    __STATE: Record<string, unknown>;
    __PLAYER?: {
      play: () => void;
      pause: () => void;
      seek: (ts: number) => void;
      snapshot: () => Record<string, unknown>;
    };
  }
}

window.__STATE = { phase: "boot" };

async function getLiveCredentials(): Promise<LiveCredentials> {
  const res = await fetch("/vend", { method: "POST" });
  if (!res.ok) throw new Error(`vend failed: ${res.status}`);
  return (await res.json()) as LiveCredentials;
}

async function fetchTelemetry(
  deviceId: string,
  params: { from: string | Date; to: string | Date; metric?: string[]; interval?: number },
): Promise<TelemetryHistory> {
  const qs = new URLSearchParams({
    deviceId,
    from: params.from instanceof Date ? params.from.toISOString() : params.from,
    to: params.to instanceof Date ? params.to.toISOString() : params.to,
  });
  if (params.metric?.length) qs.set("metric", params.metric.join(","));
  if (params.interval !== undefined) qs.set("interval", String(params.interval));
  const res = await fetch(`/telemetry?${qs}`);
  if (!res.ok) throw new Error(`telemetry proxy failed: ${res.status}`);
  const j = (await res.json()) as TelemetryHistory;
  return {
    readings: j.readings ?? [],
    bucketSeconds: j.bucketSeconds ?? null,
    truncated: j.truncated ?? false,
  };
}

function LiveTelemetryTest({ deviceId }: { deviceId: string }) {
  const feed = useLiveTelemetry(deviceId);
  useEffect(() => {
    window.__STATE = {
      test: "live-telemetry",
      status: feed.status,
      unavailableReason: feed.unavailableReason,
      error: feed.error?.message ?? null,
      metricCount: Object.keys(feed.latest).length,
      historyLength: feed.history.length,
      receivedAt: feed.receivedAt,
      gpsLat: feed.latest["gps.lat"] ?? null,
      recordingBlock: feed.recording !== null,
    };
  });
  return <pre>{feed.status}</pre>;
}

function LiveVideoTest({ channel }: { channel: VideoChannel }) {
  const { videoRef, status, error, stats } = useLiveVideo(channel);
  useEffect(() => {
    window.__STATE = {
      test: "live-video",
      status,
      error: error?.message ?? null,
      stats,
    };
  });
  return <video ref={videoRef} playsInline muted autoPlay style={{ width: 640 }} />;
}

function ReplayStateBridge({
  player,
  deviceId,
  metrics,
}: {
  player: UseReplayPlayer;
  deviceId: string;
  metrics: string[];
}) {
  const telemetry = useReplayTelemetry(deviceId, player, {
    metrics: metrics as never,
    fetchTelemetry,
  });
  // The "open to route line" clock, measured from navigation start so the
  // artifact and REST runs compare fairly: when the overview tier first
  // settled, and when the route line first had points.
  const readyAt = useRef<number | null>(null);
  const routeAt = useRef<number | null>(null);
  if (readyAt.current === null && telemetry.source !== null && !telemetry.loading) {
    readyAt.current = performance.now();
  }
  if (routeAt.current === null && telemetry.hasGps) routeAt.current = performance.now();
  useEffect(() => {
    const lane = player.lanes[0];
    const laneState = lane ? player.laneState(lane.streamKey) : null;
    const video = document.querySelector("video");
    window.__STATE = {
      test: "replay",
      lanes: player.lanes.map((l) => l.streamKey),
      timeline: player.timeline ? { from: player.timeline.from, to: player.timeline.to } : null,
      playheadTs: player.playheadTs,
      playing: player.playing,
      laneStatus: laneState?.status ?? null,
      laneInGap: laneState?.inGap ?? null,
      isPacer: laneState?.isPacer ?? null,
      videoCurrentTime: video?.currentTime ?? null,
      videoPaused: video?.paused ?? null,
      telemetryLoading: telemetry.loading,
      telemetryError: telemetry.error?.message ?? null,
      telemetrySource: telemetry.source,
      telemetryReadyMs: readyAt.current,
      routeReadyMs: routeAt.current,
      latest: Object.fromEntries(
        Object.entries(telemetry.latest).map(([k, v]) => [k, { value: v.value, ts: v.ts }]),
      ),
      position: telemetry.position,
      hasGps: telemetry.hasGps,
      routePoints: telemetry.routeLines.reduce((n, line) => n + line.length, 0),
    };
    window.__PLAYER = {
      play: player.play,
      pause: player.pause,
      seek: player.seek,
      snapshot: () => window.__STATE,
    };
  });
  return null;
}

function ReplayTest({
  deviceId,
  manifest,
  metrics,
}: {
  deviceId: string;
  manifest: ReplayManifest;
  metrics: string[];
}) {
  const player = useReplayPlayer(manifest);
  const lane = player.lanes[0];
  return (
    <div>
      {lane ? (
        <ReplayVideo player={player} streamKey={lane.streamKey} style={{ width: 640 }} />
      ) : null}
      <ReplayStateBridge player={player} deviceId={deviceId} metrics={metrics} />
    </div>
  );
}

function App() {
  const cfg = window.__TEST;
  return (
    <XorgateProvider
      auth={{ getLiveCredentials }}
      organizationId={cfg.organizationId}
      config={{}}
    >
      {cfg.test === "live-telemetry" ? <LiveTelemetryTest deviceId={cfg.deviceId} /> : null}
      {cfg.test === "live-video" && cfg.channel ? <LiveVideoTest channel={cfg.channel} /> : null}
      {cfg.test === "replay" && cfg.manifest ? (
        <ReplayTest
          deviceId={cfg.deviceId}
          manifest={cfg.manifest}
          metrics={cfg.metrics ?? []}
        />
      ) : null}
    </XorgateProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
