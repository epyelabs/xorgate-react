/**
 * Every runnable example from the Phase 4 Frontend SDK docs, compiled against
 * `interface-react.d.ts`. This is how the phase DoD ("examples type-check
 * against the sketch") is actually verified rather than asserted.
 *
 *   cd xorgate/frontend/xorgate-docs
 *   npx tsc -p ../../plans/xorgate-sdk-and-api/tsconfig.check.json
 *
 * The bare `tsc --ignoreConfig …` form Phase 3 used cannot work here: this file
 * and `interface-react.d.ts` import `react`, and there is no `node_modules`
 * anywhere above `plans/`, so nothing resolves it. The checked-in
 * `tsconfig.check.json` points at the docs site's copies of the type packages
 * and sets `skipLibCheck: false`, so both artifacts are really checked.
 *
 * Green as of 2026-08-10, against React 19.2 types.
 *
 * Not reproduced here: type declarations quoted for explanation (the
 * `LatestByMetric` block, the `LiveBlockState` union, the `TelemetryPoint`
 * shape), `<TypeTable>` listings, and the shell and JSON snippets. Those are
 * copied out of `interface-react.d.ts` and checked by reading.
 *
 * When you change a doc example, change it here too. When they disagree, the
 * docs are wrong, because this file is the one a compiler reads.
 */
import { useEffect, useState } from "react";

import {
  LiveVideo,
  REPLAY_RATES,
  ReplayVideo,
  XorgateProvider,
  useDevice,
  useDevices,
  useVideoChannels,
  useLiveVideo,
  useLiveBlock,
  useLivePlane,
  useLiveTelemetry,
  useRecordingRuns,
  useReplayManifest,
  useReplayPlayer,
  useReplayTelemetry,
  useTelemetryHistory,
  useTelemetryLatest,
  useXorgate,
  useDeviceScope,
  useLiveScope,
  type Device,
  type VideoChannel,
  type LatestByMetric,
  type LatestReading,
  type RecordingRun,
  type ReplayLane,
  type TelemetryReading,
  type UseReplayPlayer,
} from "@xorgate/react";

// ---------------------------------------------------------------------------
// Ambient stand-ins for things the consuming app owns
// ---------------------------------------------------------------------------

declare global {
  // Vite's client types are not installed here; the docs read config off
  // `import.meta.env`, which is the idiom every example in this plan uses.
  interface ImportMeta {
    env: Record<string, string>;
  }
}

declare const session: { idToken: string };
declare const auth: { currentSession(): Promise<{ getIdToken(): string }> };
declare const myBackend: {
  mintXorgateCredentials(): Promise<{
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  }>;
};
declare const idToken: string;
declare const organizationId: string | null;
declare const workspaceId: string | undefined;
declare const deviceId: string;
declare const otherWorkspaceId: string;
declare const element: HTMLElement;
declare const from: Date;
declare const to: Date;
declare function useAuth(): {
  idToken: string;
  organizationId: string | null;
};
declare function position(ts: number): number;
declare function merge(
  seed: TelemetryReading[],
  history: unknown[],
): unknown[];
declare function log(status: string, error: unknown): void;
declare function useQuery<T>(options: {
  queryKey: unknown[];
  queryFn: () => Promise<T>;
}): { data: T | undefined };

declare function Spinner(): React.ReactNode;
declare function Router(): React.ReactNode;
declare function DeviceRow(props: { device: Device }): React.ReactNode;
declare function LineChart(props: {
  data: unknown[];
  xKey: string;
  yKey: string;
}): React.ReactNode;
declare function Sparkline(props: {
  points: TelemetryReading[];
}): React.ReactNode;
declare function LiveGrid(props: { deviceId: string }): React.ReactNode;
declare function PickOrganization(): React.ReactNode;
declare function NoAccess(): React.ReactNode;
declare function Map(props: { children?: React.ReactNode }): React.ReactNode;
declare function Marker(props: {
  longitude: number;
  latitude: number;
  opacity?: number;
  children?: React.ReactNode;
}): React.ReactNode;
declare function RouteMap(props: {
  lines: [number, number][][];
  traveled: [number, number][][];
  marker: [number, number] | null;
}): React.ReactNode;

// ===========================================================================
// index.mdx
// ===========================================================================

function IndexApp() {
  return (
    <XorgateProvider
      config={{
        baseUrl: import.meta.env.VITE_API_BASE_URL,
        region: import.meta.env.VITE_AWS_REGION,
        identityPoolId: import.meta.env.VITE_COGNITO_IDENTITY_POOL_ID,
        userPoolId: import.meta.env.VITE_COGNITO_USER_POOL_ID,
        realtimeEndpoint: import.meta.env.VITE_IOT_ENDPOINT,
      }}
      auth={{ getIdToken: () => session.idToken }}
      organizationId={organizationId}
    >
      <IndexFleet />
    </XorgateProvider>
  );
}

function IndexFleet() {
  const { data: devices, isLoading } = useDevices({ status: "online" });
  if (isLoading) return <Spinner />;
  return devices?.map((d) => <DeviceRow key={d.id} device={d} />);
}

// ===========================================================================
// provider.mdx
// ===========================================================================

function ProviderExample() {
  return (
    <XorgateProvider
      config={{
        baseUrl: import.meta.env.VITE_API_BASE_URL,
        region: import.meta.env.VITE_AWS_REGION,
        identityPoolId: import.meta.env.VITE_COGNITO_IDENTITY_POOL_ID,
        userPoolId: import.meta.env.VITE_COGNITO_USER_POOL_ID,
        realtimeEndpoint: import.meta.env.VITE_IOT_ENDPOINT,
      }}
      auth={{ getIdToken }}
      organizationId={organizationId}
      workspaceId={workspaceId}
    >
      <IndexApp />
    </XorgateProvider>
  );
}

declare function getIdToken(): Promise<string | null>;

// The four auth modes, as they appear in prose.
const firstPartyAuth = {
  getIdToken: async () => (await auth.currentSession()).getIdToken(),
};
// The third-party default. One function, one credential; the live-plane
// coordinates arrive with the token, which is why `config` is one line.
const sessionTokenAuth = {
  getSessionToken: async () => {
    const r = await fetch("/api/xorgate-token", { method: "POST" });
    const { token } = (await r.json()) as { token: string };
    return token;
  },
};
const apiKeyAuth = { apiKey: process.env.XORGATE_API_KEY! };
const liveCredentialsAuth = {
  apiKey: undefined,
  getLiveCredentials: () => myBackend.mintXorgateCredentials(),
};

function AuthModes() {
  return (
    <>
      <XorgateProvider
        config={{ baseUrl: "" }}
        auth={firstPartyAuth}
        organizationId={null}
      >
        <Spinner />
      </XorgateProvider>
      <XorgateProvider
        config={{ baseUrl: import.meta.env.VITE_API_BASE_URL }}
        auth={sessionTokenAuth}
        organizationId={organizationId}
      >
        <Spinner />
      </XorgateProvider>
      <XorgateProvider
        config={{ baseUrl: "" }}
        auth={apiKeyAuth}
        organizationId={null}
      >
        <Spinner />
      </XorgateProvider>
      <XorgateProvider
        config={{ baseUrl: "" }}
        auth={liveCredentialsAuth}
        organizationId={null}
      >
        <Spinner />
      </XorgateProvider>
    </>
  );
}

function LiveBanner() {
  const { available, reason } = useLivePlane();
  if (available) return null;
  return <p role="status">Live view is unavailable ({reason}).</p>;
}

function RebootButton({ deviceId }: { deviceId: string }) {
  const xg = useXorgate();
  return <button onClick={() => xg.devices.reboot(deviceId)}>Reboot</button>;
}

// ===========================================================================
// data-hooks.mdx
// ===========================================================================

function useCachedDevices() {
  const xg = useXorgate();
  return useQuery({
    queryKey: ["xorgate", "devices"],
    queryFn: () => xg.devices.listAll(),
  });
}

function DevicesDestructure() {
  const {
    data,
    page,
    hasMore,
    loadMore,
    isLoading,
    isFetching,
    error,
    refetch,
  } = useDevices({ status: "online", limit: 100 });
  void [data, page, hasMore, loadMore, isLoading, isFetching, error, refetch];
}

function Fleet() {
  const { data, hasMore, loadMore, isLoadingMore, isLoading } = useDevices({
    sort: "lastSeenAt",
    order: "desc",
  });

  if (isLoading) return <p>Loading…</p>;

  return (
    <>
      <ul>
        {data?.map((d) => (
          <li key={d.id}>
            {d.name ?? d.serial} ({d.status})
          </li>
        ))}
      </ul>
      {hasMore ? (
        <button onClick={() => void loadMore()} disabled={isLoadingMore}>
          Load more
        </button>
      ) : null}
    </>
  );
}

function DeviceDetail() {
  const { data: device, error, isLoading } = useDevice(deviceId);
  void [device, error, isLoading];
}

function LatestPosition() {
  const { data: latest } = useTelemetryLatest(deviceId, {
    refetchIntervalMs: 15_000,
  });

  const lat = latest?.["gps.lat"];
  const lon = latest?.["gps.lon"];
  void [lat, lon];
}

const STALE_MS = 120_000;

function isFresh(reading: LatestReading | undefined, now: number): boolean {
  return reading !== undefined && now - Date.parse(reading.ts) < STALE_MS;
}

function HistoryExample() {
  const { data: history } = useTelemetryHistory(deviceId, {
    from: dayStart,
    to: dayEnd,
    metric: ["gps.speed", "imu.accel_z"],
    interval: 60,
  });
  void history;
}

declare const dayStart: Date;
declare const dayEnd: Date;

function Chart({ deviceId }: { deviceId: string }) {
  const { data } = useTelemetryHistory(deviceId, {
    from: from,
    to: to,
    metric: ["gps.speed"],
    interval: 60,
  });
  if (!data) return null;
  return (
    <>
      {data.truncated ? <p role="alert">Showing a partial range.</p> : null}
      <Sparkline points={data.readings} />
    </>
  );
}

function ErrorBranching() {
  const { error } = useDevices();

  if (error?.code === "ORGANIZATION_REQUIRED") return <PickOrganization />;
  if (error?.code === "FORBIDDEN") return <NoAccess />;
  if (error) return <p role="alert">{error.message}</p>;
  return null;
}

// ===========================================================================
// live-telemetry.mdx
// ===========================================================================

function Speed({ deviceId }: { deviceId: string }) {
  const { latest, status } = useLiveTelemetry(deviceId);
  if (status !== "connected") return <p>Connecting…</p>;
  const speed = latest["gps.speed"];
  return <p>{speed ? `${speed.value} ${speed.unit ?? ""}` : "no fix"}</p>;
}

function LiveChart({ deviceId }: { deviceId: string }) {
  const { history } = useLiveTelemetry(deviceId, { historyLimit: 600 });
  return <LineChart data={history} xKey="ts" yKey="imu.accel_z" />;
}

function SeededChart({ deviceId }: { deviceId: string }) {
  const xg = useXorgate();
  const { history } = useLiveTelemetry(deviceId);
  const [seed, setSeed] = useState<TelemetryReading[]>([]);

  useEffect(() => {
    let cancelled = false;
    void xg.telemetry
      .recent(deviceId, { metric: ["gps.speed"], limit: 300 })
      .then((r) => {
        if (!cancelled) setSeed(r.readings);
      });
    return () => {
      cancelled = true;
    };
  }, [xg, deviceId]);

  return <LineChart data={merge(seed, history)} xKey="ts" yKey="gps.speed" />;
}

function DeviceVideo({ deviceId }: { deviceId: string }) {
  const feed = useLiveTelemetry(deviceId);
  const block = useLiveBlock(feed);

  if (block.blocked) {
    return (
      <div>
        <p>Live view is paused ({block.reason}).</p>
        <p>{block.detail}</p>
        {block.parked ? <p>It will not resume on its own.</p> : null}
      </div>
    );
  }
  return <LiveGrid deviceId={deviceId} />;
}

// ===========================================================================
// live-video.mdx
// ===========================================================================

function LiveVideoGrid({ deviceId }: { deviceId: string }) {
  const { data: channels } = useVideoChannels(deviceId);
  return (
    <div>
      {channels?.map((c) => (
        <LiveVideo key={c.streamKey} channel={c} width={640} />
      ))}
    </div>
  );
}

function ViewerDestructure({ channel }: { channel: VideoChannel }) {
  const { videoRef, status, error, stats } = useLiveVideo(channel);
  void [videoRef, status, error, stats];
}

function Camera({ channel }: { channel: VideoChannel }) {
  const { videoRef, status, stats } = useLiveVideo(channel);
  return (
    <figure>
      <video ref={videoRef} playsInline muted />
      <figcaption>
        {status === "waiting" ? "Waiting for the device" : status}
        {stats?.width ? ` · ${stats.width}x${stats.height}` : ""}
        {stats?.kbps ? ` · ${Math.round(stats.kbps)} kbps` : ""}
      </figcaption>
    </figure>
  );
}

function LiveVideoUsage({ channel }: { channel: VideoChannel }) {
  return <LiveVideo channel={channel} className="camera" onStatusChange={log} />;
}

function StreamTile({
  deviceId,
  channel,
  cameraEnables,
}: {
  deviceId: string;
  channel: VideoChannel;
  cameraEnables?: Record<string, boolean>;
}) {
  const feed = useLiveTelemetry(deviceId);
  const block = useLiveBlock(feed);

  if (cameraEnables?.[channel.streamKey] === false) {
    return <p>{channel.streamKey} is turned off</p>;
  }
  if (block.blocked) {
    return <p>Live view paused: {block.detail}</p>;
  }
  return <LiveVideo channel={channel} />;
}

// ===========================================================================
// replay.mdx
// ===========================================================================

function Replay({ deviceId, run }: { deviceId: string; run: RecordingRun }) {
  const { data: manifest } = useReplayManifest(deviceId, {
    from: run.fromTs,
    to: run.toTs,
  });
  const player = useReplayPlayer(manifest);

  return (
    <div>
      {player.lanes.map((lane) => (
        <ReplayVideo
          key={lane.streamKey}
          player={player}
          streamKey={lane.streamKey}
        />
      ))}
      <button onClick={player.toggle}>
        {player.playing ? "Pause" : "Play"}
      </button>
    </div>
  );
}

function ManifestDestructure({ run }: { run: RecordingRun }) {
  const {
    data: manifest,
    error,
    refreshUrls,
  } = useReplayManifest(deviceId, {
    from: run.fromTs,
    to: run.toTs,
  });
  void [manifest, error, refreshUrls];
}

function Lane({ player, lane }: { player: UseReplayPlayer; lane: ReplayLane }) {
  const state = player.laneState(lane.streamKey);
  return (
    <div>
      <video ref={player.laneVideoRef(lane.streamKey)} playsInline muted />
      {state.inGap ? (
        <p>No video recorded for this part of the timeline.</p>
      ) : null}
    </div>
  );
}

function ImperativeSubscribe({ player }: { player: UseReplayPlayer }) {
  useEffect(() => {
    const clock = player.clock;
    if (!clock) return;
    return clock.subscribe(() => {
      element.style.transform = `translateX(${position(
        clock.getState().playheadTs,
      )}px)`;
    });
  }, [player.clock]);
}

function Scrubber({ player }: { player: UseReplayPlayer }) {
  const timeline = player.timeline;
  if (!timeline) return null;
  const span = timeline.to - timeline.from;
  const pct = ((player.playheadTs - timeline.from) / span) * 100;

  return (
    <div
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const f = (e.clientX - rect.left) / rect.width;
        player.seek(timeline.from + f * span);
      }}
    >
      {timeline.gaps.map((g) => (
        <span
          key={g.fromTs}
          data-reason={g.reason}
          style={{
            left: `${((g.fromTs - timeline.from) / span) * 100}%`,
            width: `${((g.toTs - g.fromTs) / span) * 100}%`,
          }}
        />
      ))}
      <span style={{ left: `${pct}%` }} />
    </div>
  );
}

function ReplayTelemetryDestructure({ player }: { player: UseReplayPlayer }) {
  const { latest, position, routeLines, traveledLines, hasGps } =
    useReplayTelemetry(deviceId, player);
  void [latest, position, routeLines, traveledLines, hasGps];
}

function ReplayVideoUsage({ player }: { player: UseReplayPlayer }) {
  return <ReplayVideo player={player} streamKey="cam0" className="lane" />;
}

// ===========================================================================
// asset-map-walkthrough.mdx
// ===========================================================================

// 1. Mount the provider
export function App() {
  const { idToken, organizationId } = useAuth();

  return (
    <XorgateProvider
      config={{
        baseUrl: import.meta.env.VITE_XORGATE_API_URL,
        region: import.meta.env.VITE_AWS_REGION,
        identityPoolId: import.meta.env.VITE_COGNITO_IDENTITY_POOL_ID,
        userPoolId: import.meta.env.VITE_COGNITO_USER_POOL_ID,
        realtimeEndpoint: import.meta.env.VITE_IOT_ENDPOINT,
      }}
      auth={{ getIdToken: () => idToken }}
      organizationId={organizationId}
      onError={(e) => console.error("xorgate", e.code, e.message)}
    >
      <Router />
    </XorgateProvider>
  );
}

// 2. The fleet list
export function useFleet() {
  return useDevices({
    status: "any",
    sort: "lastSeenAt",
    order: "desc",
    limit: 100,
  });
}

// 3. Live positions, push
interface AssetPosition {
  deviceId: string;
  lon: number;
  lat: number;
  speedKph: number | null;
  /** Browser clock. The only trustworthy freshness signal. */
  receivedAt: number | null;
  live: boolean;
}

function num(reading: LatestReading | undefined): number | null {
  return reading && typeof reading.value === "number" ? reading.value : null;
}

export function useAssetPosition(deviceId: string): AssetPosition | null {
  const { latest, receivedAt, status } = useLiveTelemetry(deviceId);
  const lat = num(latest["gps.lat"]);
  const lon = num(latest["gps.lon"]);
  if (lat === null || lon === null) return null;
  return {
    deviceId,
    lon,
    lat,
    speedKph: num(latest["gps.speed"]),
    receivedAt,
    live: status === "connected",
  };
}

// 4. Live positions, polled
export function usePolledAssetPosition(
  deviceId: string,
  now: number,
): AssetPosition | null {
  const { data: latest } = useTelemetryLatest(deviceId, {
    refetchIntervalMs: 20_000,
  });
  if (!latest) return null;
  const lat = num(latest["gps.lat"]);
  const lon = num(latest["gps.lon"]);
  const ts = latest["gps.lat"]?.ts;
  if (lat === null || lon === null || ts === undefined) return null;
  const at = Date.parse(ts);
  return {
    deviceId,
    lon,
    lat,
    speedKph: num(latest["gps.speed"]),
    receivedAt: at,
    live: now - at < STALE_MS,
  };
}

// 5. The map
export function FleetMap({ devices }: { devices: Device[] }) {
  return (
    <Map>
      {devices.map((d) => (
        <AssetMarker key={d.id} device={d} />
      ))}
    </Map>
  );
}

function AssetMarker({ device }: { device: Device }) {
  const pos = useAssetPosition(device.id);
  if (!pos) return null;
  return (
    <Marker longitude={pos.lon} latitude={pos.lat} opacity={pos.live ? 1 : 0.4}>
      <span>{device.name ?? device.serial}</span>
    </Marker>
  );
}

// 6. Live video for the selected asset
export function AssetLiveView({ deviceId }: { deviceId: string }) {
  const feed = useLiveTelemetry(deviceId);
  const block = useLiveBlock(feed);
  const { data: channels, isLoading } = useVideoChannels(deviceId);

  if (block.blocked) {
    return (
      <div>
        <p>Live view is paused.</p>
        <p>{block.detail}</p>
        {block.parked ? (
          <p>It will not resume without a restart or a settings change.</p>
        ) : null}
      </div>
    );
  }
  if (isLoading) return <p>Loading cameras…</p>;
  if (!channels || channels.length === 0) {
    return <p>This device has no cameras provisioned.</p>;
  }
  return (
    <>
      {channels.map((c) => (
        <LiveVideo key={c.streamKey} channel={c} />
      ))}
    </>
  );
}

// 7. Find the incident
export function IncidentPicker({
  deviceId,
  around,
  onPick,
}: {
  deviceId: string;
  around: Date;
  onPick: (run: RecordingRun) => void;
}) {
  const { data: runs, isLoading } = useRecordingRuns(deviceId, {
    from: new Date(around.getTime() - 60 * 60 * 1000),
    to: new Date(around.getTime() + 60 * 60 * 1000),
  });

  if (isLoading) return <p>Loading recordings…</p>;
  return (
    <ul>
      {runs?.map((run) => (
        <li key={run.key}>
          <button onClick={() => onPick(run)}>
            {new Date(run.fromTs).toLocaleTimeString()} ·{" "}
            {run.streamKeys.join(", ")} · {run.sessionCount} sessions
            {run.anyUnsynced ? " · clock unsynced" : ""}
          </button>
        </li>
      ))}
    </ul>
  );
}

// 8. The replay page
export function IncidentReplay({
  deviceId,
  run,
}: {
  deviceId: string;
  run: RecordingRun;
}) {
  const { data: manifest, error } = useReplayManifest(deviceId, {
    from: run.fromTs,
    to: run.toTs,
  });
  const player = useReplayPlayer(manifest);
  const telemetry = useReplayTelemetry(deviceId, player);

  if (error) return <p role="alert">{error.message}</p>;
  if (!manifest) return <p>Loading replay…</p>;

  return (
    <div>
      <div>
        {player.lanes.map((lane) => (
          <ReplayLaneTile key={lane.streamKey} player={player} lane={lane} />
        ))}
      </div>

      <Transport player={player} />

      <RouteMap
        lines={telemetry.routeLines}
        traveled={telemetry.traveledLines}
        marker={telemetry.position}
      />

      <Readouts latest={telemetry.latest} />
    </div>
  );
}

export function Readouts({ latest }: { latest: LatestByMetric }) {
  const speed = latest["gps.speed"];
  const accel = latest["imu.accel_z"];
  return (
    <dl>
      <dt>Speed</dt>
      <dd>{speed ? `${speed.value} ${speed.unit ?? ""}` : "-"}</dd>
      <dt>Vertical g</dt>
      <dd>{accel ? `${accel.value} ${accel.unit ?? ""}` : "-"}</dd>
    </dl>
  );
}

// 9. Lanes and gaps
export function ReplayLaneTile({
  player,
  lane,
}: {
  player: UseReplayPlayer;
  lane: ReplayLane;
}) {
  const state = player.laneState(lane.streamKey);
  return (
    <figure>
      <video ref={player.laneVideoRef(lane.streamKey)} playsInline muted />
      {state.inGap ? (
        <figcaption>No footage from {lane.streamKey} here.</figcaption>
      ) : null}
      {lane.unsynced ? (
        <figcaption>Recorded with an unsynced clock.</figcaption>
      ) : null}
    </figure>
  );
}

// 10. Transport and scrubber
export function Transport({ player }: { player: UseReplayPlayer }) {
  const timeline = player.timeline;
  if (!timeline) return null;

  return (
    <div>
      <button onClick={() => player.stepBoundary(-1)}>Prev</button>
      <button onClick={player.toggle}>
        {player.playing ? "Pause" : "Play"}
      </button>
      <button onClick={() => player.stepBoundary(1)}>Next</button>

      {REPLAY_RATES.map((r) => (
        <button
          key={r}
          aria-pressed={player.rate === r}
          onClick={() => player.setRate(r)}
        >
          {r}x
        </button>
      ))}

      <label>
        <input
          type="checkbox"
          checked={player.skipGaps}
          onChange={(e) => player.setSkipGaps(e.currentTarget.checked)}
        />
        Skip gaps
      </label>

      <input
        type="range"
        min={timeline.from}
        max={timeline.to}
        value={player.playheadTs}
        onChange={(e) => player.seek(Number(e.currentTarget.value))}
      />

      <time>{new Date(player.playheadTs).toLocaleTimeString()}</time>

      {player.lastSkip ? (
        <span>
          Skipped{" "}
          {Math.round((player.lastSkip.toTs - player.lastSkip.fromTs) / 1000)}s
          with no video
        </span>
      ) : null}
    </div>
  );
}

// Imperative writes (not-covered.mdx).
export function ConfigWrite() {
  const xg = useXorgate();
  const { refetch } = useDevice(deviceId);
  return (
    <button
      onClick={async () => {
        await xg.devices.patchConfig(deviceId, { gnssAntBias: true });
        await refetch();
      }}
    >
      Enable antenna bias
    </button>
  );
}


// ---------------------------------------------------------------------------
// Live scope: a device can be transferred out from under an open viewer
// ---------------------------------------------------------------------------

/**
 * Gate the live hooks on the scope guard. Without this a transferred device
 * produces an empty telemetry feed and nothing else — no error, no status
 * change, indistinguishable from an idle device.
 */
export function GuardedLive() {
  const scope = useDeviceScope(deviceId);
  const live = useLiveTelemetry(scope.outOfScope ? null : deviceId);

  if (scope.error) return <p role="alert">{scope.error.message}</p>;
  return <p>{live.status}</p>;
}

/** Invalidate the live scope yourself after moving a device. */
export function TransferButton() {
  const xg = useXorgate();
  const { invalidate } = useLiveScope();
  return (
    <button
      onClick={async () => {
        await xg.devices.transfer(deviceId, { workspaceId: otherWorkspaceId });
        // Every open live consumer re-resolves NOW instead of holding the old
        // scope for up to ~50 minutes.
        invalidate();
      }}
    >
      Transfer
    </button>
  );
}

/** What the live credential is scoped to, which is not the provider's props. */
export function ScopeBadge() {
  const { organizationId, workspaceId } = useLiveScope();
  return <span>{workspaceId ?? organizationId ?? "unscoped"}</span>;
}

// Keep every declaration reachable so nothing above is dead weight.
export const _used = [
  IndexApp,
  IndexFleet,
  ProviderExample,
  AuthModes,
  LiveBanner,
  RebootButton,
  useCachedDevices,
  DevicesDestructure,
  Fleet,
  DeviceDetail,
  LatestPosition,
  isFresh,
  HistoryExample,
  Chart,
  ErrorBranching,
  Speed,
  LiveChart,
  SeededChart,
  DeviceVideo,
  LiveVideoGrid,
  ViewerDestructure,
  Camera,
  LiveVideoUsage,
  StreamTile,
  Replay,
  ManifestDestructure,
  Lane,
  ImperativeSubscribe,
  Scrubber,
  ReplayTelemetryDestructure,
  ReplayVideoUsage,
  GuardedLive,
  TransferButton,
  ScopeBadge,
];
