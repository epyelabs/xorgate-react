import { useEffect, useMemo, useRef, useState } from "react";
import { XorgateError } from "@xorgate/sdk";
import type {
  LatestByMetric,
  MetricName,
  ReplayTelemetry,
  ReplayTelemetrySegment,
  ReplayTelemetrySession,
  TelemetryHistory,
} from "@xorgate/sdk";
import { declaredMetrics } from "@xorgate/sdk";
import { useXorgateContext } from "../context.js";
import type { UseTelemetryHistoryParams } from "../query/hooks.js";
import type { UseReplayPlayerCore } from "./use-replay-player-core.js";
import {
  artifactKey,
  buildOverviewSeries,
  buildTrace,
  chooseIntervalSeconds,
  latestWithin,
  mergeSeries,
  metricGroup,
  overviewStalenessMs,
  overviewToSeries,
  positionAt,
  segmentToSeries,
  segmentsCovering,
  seriesFromReadings,
  stalenessMs,
  traceLines,
  traveledLines,
  windowBoundsFor,
  windowNeedsRefetch,
  DEFAULT_STALENESS_MS,
  GROUP_STALENESS_MS,
  OVERVIEW_DEFAULT_TARGET_BUCKETS,
  OVERVIEW_GPS_TARGET_BUCKETS,
  WINDOW_MIN_SPAN_MS,
  WINDOW_SPAN_MS,
  type DecodedSegment,
  type GpsTrace,
  type MetricSeries,
  type OverviewV1,
  type WindowBounds,
  clipSeries,
  summarizeGpsSeries,
  DEFAULT_BREAK_GAP_MS,
  type GpsSummary,
} from "./replay-telemetry.js";

// Pre-roll so a floor sample exists right at the replay start even for the
// slowest group (lte's ~15-20 s effective cadence).
const OVERVIEW_PREROLL_MS = 60_000;
// Artifact window pre-roll: one segment before the window start so the
// slowest group (lte, 60 s staleness) has a floor sample at the window edge.
const WINDOW_PREROLL_MS = 60_000;
// Marker interpolation only bridges near-adjacent fixes; anything wider
// holds, then hides via staleness.
const MARKER_INTERP_MS = 3_000;
// Back off failed window fetches briefly so an outage does not hammer the API
// (or S3) at snapshot rate.
const WINDOW_ERROR_BACKOFF_MS = 5_000;
/** Route-break floor when the caller does not override it. */
// Raw segments fetched at once while building an overview client-side.
const ARTIFACT_CONCURRENCY = 6;
// A lapsed manifest 403s on EVERY artifact URL at once; tell the player once.
const EXPIRY_NOTICE_THROTTLE_MS = 30_000;
// In artifact mode one window serves every group (a segment holds them all).
const ARTIFACT_WINDOW_KEY = "*";

/** The small fallback set when neither `metrics` nor a device model is reachable. */
const FALLBACK_METRICS: MetricName[] = [
  "gps.lat",
  "gps.lon",
  "gps.speed",
  "gps.course",
  "system.cpu_temp",
  "system.cpu_usage",
];

/** Where a replay's telemetry comes from. */
export type ReplayTelemetrySource = "artifacts" | "rest";

export interface UseReplayTelemetryOptions {
  /**
   * Metrics to resolve. In artifact mode defaults to every metric the
   * artifacts contain; on the REST path to everything the device model
   * declares when a REST credential is available, else a small default set.
   */
  metrics?: MetricName[];
  /** High-resolution window around the playhead. Default 120000. */
  windowSpanMs?: number;
  /** Consecutive-fix gap that breaks the route polyline. Default 30000. */
  breakGapMs?: number;
  /**
   * How telemetry history is fetched on the REST path. Defaults to the REST
   * client. A PROXIED consumer (browser holds no xorgate REST credential)
   * points this at its own backend, which relays `GET /devices/{id}/telemetry`
   * with its API key. Not consulted when the manifest carries its `telemetry`
   * block: the artifacts are presigned and need no credential.
   */
  fetchTelemetry?: (
    deviceId: string,
    params: UseTelemetryHistoryParams,
  ) => Promise<TelemetryHistory>;
}

export interface UseReplayTelemetry {
  /**
   * The SAME interop shape live telemetry emits, resolved at the playhead.
   * One readout component renders live and replay without knowing which it
   * is looking at.
   */
  latest: LatestByMetric;
  /** `[lon, lat]`, or null when the playhead sits in a GPS hole. */
  position: [number, number] | null;
  course: number | null;
  /** The whole recorded route, split at recording holes. */
  routeLines: [number, number][][];
  /** The traveled portion, up to the playhead. */
  traveledLines: [number, number][][];
  /** Whether the window recorded any GPS at all, for honest empty-state copy. */
  hasGps: boolean;
  loading: boolean;
  /** Every overview source failed (every session's artifacts, or every REST group). */
  error: XorgateError | null;
  /**
   * `"artifacts"` when the manifest carried its `telemetry` block (presigned
   * S3 objects, no REST call is ever made), `"rest"` for the history routes
   * (an older server, a `telemetry: false` request, or a proxied manifest
   * without the block). Null until a replay exists.
   */
  source: ReplayTelemetrySource | null;
  /**
   * Distance and moving time over the replay's OWN window, integrated over
   * the overview series (clipped to the timeline). Null until the overview
   * settles or when the window holds no GPS. This is the number a header
   * should print: the manifest's per-session `insights` describe whole
   * telemetry sessions, which need not line up with a replay.
   */
  overviewSummary: GpsSummary | null;
}

interface MetricGroupSpec {
  key: string;
  metrics: MetricName[];
}

interface GroupWindow {
  bounds: WindowBounds | null;
  spanMs: number;
  series: Map<MetricName, MetricSeries>;
  fetching: boolean;
  lastErrorAt: number;
  /** Artifact mode: the segment keys the window was built from. */
  keys: string;
}

/**
 * Presigned artifacts, cached by S3 key (the URL without its query string)
 * for the hook's lifetime: a manifest URL refresh or a second window over the
 * same segments never refetches bytes. Promises are cached so a segment
 * wanted by the overview build and the window at the same time is fetched
 * once; a rejected one is evicted so the next attempt (with a fresh URL
 * after a 403, or after a network blip) can try again.
 */
class ArtifactLoader {
  private readonly overviews = new Map<string, Promise<OverviewV1>>();
  private readonly segments = new Map<string, Promise<DecodedSegment>>();
  /** Latest presigned URL per key, from the newest manifest. */
  private readonly urls = new Map<string, string>();
  private lastForbiddenAt = 0;

  constructor(private readonly onForbidden: () => void) {}

  updateUrls(telemetry: ReplayTelemetry): void {
    for (const session of telemetry.sessions) {
      if (session.overview) this.urls.set(artifactKey(session.overview.url), session.overview.url);
      for (const seg of session.segments) this.urls.set(artifactKey(seg.url), seg.url);
    }
  }

  overview(key: string): Promise<OverviewV1> {
    let p = this.overviews.get(key);
    if (!p) {
      p = this.get(key).then((res) => res.json() as Promise<OverviewV1>);
      this.overviews.set(key, p);
      p.catch(() => this.overviews.delete(key));
    }
    return p;
  }

  segment(key: string): Promise<DecodedSegment> {
    let p = this.segments.get(key);
    if (!p) {
      p = this.get(key).then(async (res) => segmentToSeries(await res.text(), key));
      this.segments.set(key, p);
      p.catch(() => this.segments.delete(key));
    }
    return p;
  }

  hasSegment(key: string): boolean {
    return this.segments.has(key);
  }

  private async get(key: string): Promise<Response> {
    const url = this.urls.get(key);
    if (!url) {
      throw new XorgateError({
        code: "INVALID_INPUT",
        message: `Telemetry artifact ${key} is not in the current manifest.`,
        details: { key },
      });
    }
    const res = await fetch(url);
    if (res.status === 403) {
      // The presigned URLs have lapsed (or were revoked): the same seam a
      // video segment 403 takes, once per burst.
      const now = Date.now();
      if (now - this.lastForbiddenAt > EXPIRY_NOTICE_THROTTLE_MS) {
        this.lastForbiddenAt = now;
        this.onForbidden();
      }
      throw new XorgateError({
        code: "FORBIDDEN",
        status: 403,
        message: `Telemetry artifact ${key} was refused (403): the presigned URL has expired.`,
        details: { key },
        retryable: true,
      });
    }
    if (!res.ok) {
      throw new XorgateError({
        code: res.status >= 500 ? "SERVER_ERROR" : "BAD_REQUEST",
        status: res.status,
        message: `Telemetry artifact ${key}: HTTP ${res.status}.`,
        details: { key },
        retryable: res.status >= 500,
      });
    }
    return res;
  }
}

async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * One telemetry session's overview series: the precomputed artifact when the
 * manifest lists one, else built here from the session's raw segments (an
 * open session, or one closed so recently the server has not built it yet).
 */
async function loadSessionOverview(
  loader: ArtifactLoader,
  session: ReplayTelemetrySession,
): Promise<Map<MetricName, MetricSeries>> {
  if (session.overview) {
    return overviewToSeries(await loader.overview(artifactKey(session.overview.url)));
  }
  const decoded = await mapConcurrent(session.segments, ARTIFACT_CONCURRENCY, (seg) =>
    loader.segment(artifactKey(seg.url)),
  );
  return buildOverviewSeries(mergeSeries(decoded.map((d) => d.series)));
}

function toXorgateError(err: unknown): XorgateError {
  return err instanceof XorgateError
    ? err
    : new XorgateError({ code: "NETWORK", message: (err as Error)?.message ?? String(err) });
}

/**
 * Telemetry for a replay, in two tiers: one coarse pass over the whole window
 * for the route and the scrub preview, plus a raw high-resolution window that
 * follows the playhead with hysteresis.
 *
 * Two sources, chosen per replay. When the manifest carries its `telemetry`
 * block (`player.telemetry`), the tiers are the session artifacts: the
 * per-session overview object (built here from the raw segments while a
 * session is still open) and the raw 60 s segments, all presigned S3 GETs
 * and no REST call at all. Without the block, the REST history routes
 * serve both tiers as before, through `fetchTelemetry` when given.
 *
 * `player` is the player CORE, not the browser wrapper: this reads a timeline
 * and a playhead and has no idea what is playing the video, which is what
 * lets `@xorgate/react-native`'s player drive it unchanged. `UseReplayPlayer`
 * extends the core, so a browser caller passes the same object it always did.
 */
export function useReplayTelemetry(
  deviceId: string | null,
  player: UseReplayPlayerCore,
  options: UseReplayTelemetryOptions = {},
): UseReplayTelemetry {
  const ctx = useXorgateContext();
  const timeline = player.timeline;
  const telemetry = player.telemetry;
  const playheadTs = player.playheadTs || timeline?.from || 0;
  const source: ReplayTelemetrySource | null = timeline ? (telemetry ? "artifacts" : "rest") : null;
  const artifacts = source === "artifacts";

  const optionMetricsKey = options.metrics?.join(",") ?? "";
  const fetchTelemetryRef = useRef(options.fetchTelemetry);
  fetchTelemetryRef.current = options.fetchTelemetry;
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const notifyUrlsExpiredRef = useRef(player.notifyUrlsExpired);
  notifyUrlsExpiredRef.current = player.notifyUrlsExpired;

  const fetchHistory = useMemo(
    () =>
      async (id: string, params: UseTelemetryHistoryParams): Promise<TelemetryHistory> => {
        const custom = fetchTelemetryRef.current;
        if (custom) return custom(id, params);
        const rest = ctxRef.current.rest;
        if (rest.kind !== "ready") {
          throw new XorgateError({
            code: "INVALID_CONFIG",
            message:
              "Replay telemetry needs a REST credential, or a fetchTelemetry " +
              "override for the proxied profile.",
          });
        }
        return rest.client.telemetry.history(id, params);
      },
    [],
  );

  // --- artifact loader (cache by S3 key, per device) -----------------------
  const loaderRef = useRef<ArtifactLoader | null>(null);
  const loaderDeviceRef = useRef<string | null>(null);
  if (!loaderRef.current || loaderDeviceRef.current !== deviceId) {
    loaderDeviceRef.current = deviceId;
    loaderRef.current = new ArtifactLoader(() => notifyUrlsExpiredRef.current?.());
  }
  const loader = loaderRef.current;
  // Fresh presigned URLs on EVERY manifest change, like the player's URL map.
  useMemo(() => {
    if (telemetry) loader.updateUrls(telemetry);
  }, [telemetry, loader]);

  // Identity of the block's CONTENT (which sessions, which objects), ignoring
  // the presigned query strings: a URL-only refresh changes nothing here.
  const telemetryKey = useMemo(() => {
    if (!telemetry) return null;
    return telemetry.sessions
      .map(
        (s) =>
          `${s.id}:${s.status}:${s.overview ? artifactKey(s.overview.url) : "-"}:` +
          s.segments.map((seg) => artifactKey(seg.url)).join(","),
      )
      .join(";");
  }, [telemetry]);
  const allSegments = useMemo<ReplayTelemetrySegment[]>(() => {
    if (!telemetry) return [];
    return telemetry.sessions.flatMap((s) => s.segments).sort((a, b) => a.startTs - b.startTs);
  }, [telemetry]);

  // --- overview tier -------------------------------------------------------
  const [overview, setOverview] = useState<{
    series: Map<MetricName, MetricSeries>;
    loading: boolean;
    error: XorgateError | null;
  }>({ series: new Map(), loading: false, error: null });
  // Which replay (and source) the overview tier last settled for. `loading`
  // is true from the moment a replay exists until its first overview run
  // completes, so a consumer never sees a "no GPS recorded" frame before the
  // first fetch has even started.
  const runKey = timeline ? `${source}:${deviceId}:${timeline.from}:${timeline.to}` : null;
  const [settledKey, setSettledKey] = useState<string | null>(null);

  // --- metric groups -------------------------------------------------------
  // Artifact mode: every metric the artifacts contain (no device/model round
  // trip). REST: everything the device model declares when REST can reach
  // it, else the fallback set. `metrics` wins in both.
  const [restMetrics, setRestMetrics] = useState<MetricName[] | null>(null);
  useEffect(() => {
    if (source !== "rest") return;
    if (options.metrics && options.metrics.length > 0) return;
    if (!deviceId) return;
    const rest = ctxRef.current.rest;
    if (rest.kind !== "ready" && !fetchTelemetryRef.current) return;
    if (rest.kind !== "ready") {
      setRestMetrics(FALLBACK_METRICS);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const device = await rest.client.devices.get(deviceId);
        const model = await rest.client.deviceModels.get(device.deviceModelId);
        if (cancelled) return;
        const declared = declaredMetrics(model);
        setRestMetrics(declared.length > 0 ? declared : FALLBACK_METRICS);
      } catch {
        if (!cancelled) setRestMetrics(FALLBACK_METRICS);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId, optionMetricsKey, source]);

  const artifactMetrics = useMemo(() => [...overview.series.keys()], [overview.series]);
  const resolvedMetrics = useMemo<MetricName[] | null>(() => {
    if (options.metrics && options.metrics.length > 0) return options.metrics;
    return artifacts ? artifactMetrics : restMetrics;
    // optionMetricsKey stands in for the metrics array identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optionMetricsKey, artifacts, artifactMetrics, restMetrics]);

  const groups = useMemo<MetricGroupSpec[]>(() => {
    if (!resolvedMetrics) return [];
    const byGroup = new Map<string, MetricName[]>();
    for (const m of resolvedMetrics) {
      const g = metricGroup(m);
      const list = byGroup.get(g);
      if (list) list.push(m);
      else byGroup.set(g, [m]);
    }
    return [...byGroup.entries()].map(([key, metrics]) => ({ key, metrics }));
  }, [resolvedMetrics]);
  const groupsKey = groups.map((g) => g.metrics.join(",")).join(";");

  // Artifact overview: one GET per session with a built artifact, else that
  // session's segments (cached, six at a time) bucketed here. Sessions merge
  // in `from` order. allSettled: one failed session degrades that session,
  // not the replay; `error` only when every session failed.
  const lastArtifactRunRef = useRef<{ key: string; ok: boolean } | null>(null);
  useEffect(() => {
    if (!artifacts || !telemetry || !timeline || telemetryKey === null) return;
    const last = lastArtifactRunRef.current;
    // Only the presigned query strings changed and nothing had failed:
    // nothing to refetch. (A failure re-runs on the next manifest, which is
    // how a 403 recovers: the refresh it triggered brings fresh URLs.)
    if (last && last.key === telemetryKey && last.ok) return;
    let cancelled = false;
    setOverview((prev) => ({
      series: prev.series,
      loading: prev.series.size === 0 && telemetry.sessions.length > 0,
      error: null,
    }));
    void (async () => {
      const sessions = [...telemetry.sessions].sort((a, b) => a.from - b.from);
      const results = await Promise.allSettled(sessions.map((s) => loadSessionOverview(loader, s)));
      if (cancelled) return;
      const parts: Map<MetricName, MetricSeries>[] = [];
      const failures: XorgateError[] = [];
      // An overview covers its whole telemetry session; the replay wants only
      // its own window (plus the same preroll the REST path fetches).
      const clipFrom = timeline.from - OVERVIEW_PREROLL_MS;
      const clipTo = timeline.to + 2_000;
      for (const r of results) {
        if (r.status === "fulfilled") parts.push(clipSeries(r.value, clipFrom, clipTo));
        else failures.push(toXorgateError(r.reason));
      }
      for (const f of failures) ctxRef.current.reportError(f);
      lastArtifactRunRef.current = { key: telemetryKey, ok: failures.length === 0 };
      const allFailed = sessions.length > 0 && parts.length === 0;
      setOverview({
        series: mergeSeries(parts),
        loading: false,
        error: allFailed ? failures[0] : null,
      });
      setSettledKey(runKey);
    })();
    return () => {
      cancelled = true;
    };
    // runKey is derived from the deps listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifacts, telemetry, telemetryKey, timeline, loader]);

  // A new replay forgets the last artifact run.
  useEffect(() => {
    lastArtifactRunRef.current = null;
  }, [deviceId, timeline]);

  // REST overview: one interval-averaged call per metric group. allSettled
  // (README D10): a throttled `system` call must not wipe `gps`.
  useEffect(() => {
    if (source !== "rest" || !deviceId || !timeline || groups.length === 0) return;
    let cancelled = false;
    setOverview({ series: new Map(), loading: true, error: null });
    const spanMs = timeline.to - timeline.from;
    void (async () => {
      const fromIso = new Date(timeline.from - OVERVIEW_PREROLL_MS).toISOString();
      const toIso = new Date(timeline.to + 2_000).toISOString();
      const results = await Promise.allSettled(
        groups.map(async (g) => {
          const interval = chooseIntervalSeconds(
            spanMs + OVERVIEW_PREROLL_MS,
            g.metrics.length,
            g.key === "gps" ? OVERVIEW_GPS_TARGET_BUCKETS : OVERVIEW_DEFAULT_TARGET_BUCKETS,
          );
          const history = await fetchHistory(deviceId, {
            from: fromIso,
            to: toIso,
            metric: g.metrics,
            interval,
          });
          return seriesFromReadings(history.readings, history.bucketSeconds ?? interval);
        }),
      );
      if (cancelled) return;
      const series = new Map<MetricName, MetricSeries>();
      const failures: XorgateError[] = [];
      for (const r of results) {
        if (r.status === "fulfilled") {
          for (const [metric, s] of r.value) series.set(metric, s);
        } else {
          failures.push(toXorgateError(r.reason));
        }
      }
      for (const f of failures) ctxRef.current.reportError(f);
      setOverview({
        series,
        loading: false,
        error: failures.length === groups.length ? failures[0] : null,
      });
      setSettledKey(runKey);
    })();
    return () => {
      cancelled = true;
    };
    // groupsKey stands in for the groups array identity; runKey derives from the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, deviceId, timeline, groupsKey, fetchHistory]);

  // --- high-res window tier (hysteresis around the playhead) ---------------
  const windowsRef = useRef(new Map<string, GroupWindow>());
  const generationRef = useRef(0);
  const [windowVersion, setWindowVersion] = useState(0);
  const windowSpanMs = options.windowSpanMs ?? WINDOW_SPAN_MS;

  // New replay (or, on REST, metric set): drop all windows and invalidate
  // in-flight fetches from the previous one. In artifact mode the metric
  // set is discovered FROM the data and must not reset the window.
  const windowResetKey = artifacts ? "" : groupsKey;
  useEffect(() => {
    generationRef.current++;
    windowsRef.current = new Map();
    setWindowVersion((v) => v + 1);
  }, [deviceId, timeline, windowResetKey, source]);

  // Artifact window: the raw segments whose bounds cover the window (plus one
  // segment of pre-roll), one window for every group. Same hysteresis as the
  // REST window, expressed over segment coverage; a manifest refresh that
  // lists a new segment inside the current bounds (an open session growing)
  // re-runs it, and the cache serves everything already fetched.
  useEffect(() => {
    if (!artifacts || !timeline) return;
    const generation = generationRef.current;
    const now = performance.now();
    let win = windowsRef.current.get(ARTIFACT_WINDOW_KEY);
    if (!win) {
      win = {
        bounds: null,
        spanMs: windowSpanMs,
        series: new Map(),
        fetching: false,
        lastErrorAt: 0,
        keys: "",
      };
      windowsRef.current.set(ARTIFACT_WINDOW_KEY, win);
    }
    if (win.fetching) return;
    if (win.lastErrorAt > 0 && now - win.lastErrorAt < WINDOW_ERROR_BACKOFF_MS) return;
    const desired = windowBoundsFor(playheadTs, win.spanMs, timeline.from, timeline.to);
    const wanted = segmentsCovering(allSegments, desired.fromTs - WINDOW_PREROLL_MS, desired.toTs);
    const keys = wanted.map((seg) => artifactKey(seg.url));
    const keysId = keys.join("\n");
    const moved = windowNeedsRefetch(win.bounds, playheadTs, win.spanMs, timeline.from, timeline.to);
    if (!moved && win.keys === keysId) return;

    win.fetching = true;
    const target = win;
    void (async () => {
      const results = await Promise.allSettled(keys.map((key) => loader.segment(key)));
      if (generationRef.current !== generation) return;
      target.fetching = false;
      const decoded: DecodedSegment[] = [];
      for (const r of results) {
        if (r.status === "fulfilled") decoded.push(r.value);
      }
      if (decoded.length < results.length) {
        // Keep the previous window and try again after the backoff; a 403
        // has already asked the player for fresh URLs.
        target.lastErrorAt = performance.now();
        return;
      }
      target.series = mergeSeries(decoded.map((d) => d.series));
      target.bounds = desired;
      target.keys = keysId;
      target.lastErrorAt = 0;
      setWindowVersion((v) => v + 1);
      // Prefetch the next segment so the playhead never waits at a boundary.
      const withNext = segmentsCovering(allSegments, desired.fromTs - WINDOW_PREROLL_MS, desired.toTs, true);
      if (withNext.length > wanted.length) {
        const nextKey = artifactKey(withNext[withNext.length - 1].url);
        if (!loader.hasSegment(nextKey)) void loader.segment(nextKey).catch(() => undefined);
      }
    })();
    // playheadTs (≤10 Hz) is the scheduler tick; windowVersion re-runs the
    // check after every fetch completion; allSegments after every manifest.
  }, [artifacts, timeline, allSegments, playheadTs, windowVersion, windowSpanMs, loader]);

  // REST window: one raw window per metric group.
  useEffect(() => {
    if (source !== "rest" || !deviceId || !timeline || groups.length === 0) return;
    const generation = generationRef.current;
    const now = performance.now();
    for (const g of groups) {
      let win = windowsRef.current.get(g.key);
      if (!win) {
        win = {
          bounds: null,
          spanMs: windowSpanMs,
          series: new Map(),
          fetching: false,
          lastErrorAt: 0,
          keys: "",
        };
        windowsRef.current.set(g.key, win);
      }
      if (win.fetching) continue;
      if (now - win.lastErrorAt < WINDOW_ERROR_BACKOFF_MS && win.lastErrorAt > 0) continue;
      if (!windowNeedsRefetch(win.bounds, playheadTs, win.spanMs, timeline.from, timeline.to)) {
        continue;
      }

      win.fetching = true;
      const target = win;
      const preRollMs = GROUP_STALENESS_MS[g.key] ?? DEFAULT_STALENESS_MS;
      void (async () => {
        try {
          let spanMs = target.spanMs;
          for (;;) {
            const bounds = windowBoundsFor(playheadTs, spanMs, timeline.from, timeline.to);
            const history = await fetchHistory(deviceId, {
              from: new Date(bounds.fromTs - preRollMs).toISOString(),
              to: new Date(bounds.toTs).toISOString(),
              metric: g.metrics,
            });
            if (generationRef.current !== generation) return;
            // Truncated = the raw cap cut the tail off. Adapt: halve the span
            // and refetch (sticky, so future windows start at the fitting
            // size). At the floor, keep the rows but only claim coverage up
            // to the last row actually returned.
            if (history.truncated && spanMs > WINDOW_MIN_SPAN_MS) {
              spanMs = Math.max(WINDOW_MIN_SPAN_MS, spanMs / 2);
              target.spanMs = spanMs;
              continue;
            }
            const series = seriesFromReadings(history.readings, null);
            let toTs = bounds.toTs;
            if (history.truncated) {
              let lastTs = bounds.fromTs;
              for (const s of series.values()) {
                const t = s.ts[s.ts.length - 1];
                if (t > lastTs) lastTs = t;
              }
              toTs = lastTs;
            }
            target.bounds = { fromTs: bounds.fromTs, toTs };
            target.series = series;
            target.fetching = false;
            setWindowVersion((v) => v + 1);
            return;
          }
        } catch {
          if (generationRef.current !== generation) return;
          target.fetching = false;
          target.lastErrorAt = performance.now();
        }
      })();
    }
    // playheadTs (≤10 Hz) is the scheduler tick; windowVersion re-runs the
    // check after every fetch completion — a seek during an in-flight fetch
    // would otherwise land a window centered on the OLD playhead with nothing
    // to correct it until the next clock notify (never, while paused).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, deviceId, timeline, groupsKey, playheadTs, windowVersion, windowSpanMs, fetchHistory]);

  // --- derivations (all O(log n), at the ≤10 Hz snapshot rate) -------------

  // Nearest sample ≤ playhead: the raw window is the truth while the playhead
  // is inside its bounds (absent there = a real recording hole); elsewhere the
  // bucketed overview answers with a widened cutoff. In artifact mode a
  // window holds every group a segment carried, so a metric with no series
  // in the window at all (never emitted, or a truncated manifest) falls
  // through to the overview rather than blanking.
  const resolve = useMemo(() => {
    void windowVersion;
    const windows = windowsRef.current;
    const overviewSeries = overview.series;
    return (metric: MetricName, ts: number) => {
      const win = windows.get(artifacts ? ARTIFACT_WINDOW_KEY : metricGroup(metric));
      if (win?.bounds && ts >= win.bounds.fromTs && ts <= win.bounds.toTs) {
        const s = win.series.get(metric);
        if (s) return latestWithin(metric, s, ts, stalenessMs(metric));
        if (!artifacts) return null;
      }
      const s = overviewSeries.get(metric);
      if (!s) return null;
      return latestWithin(metric, s, ts, overviewStalenessMs(metric, s.bucketMs ?? 0));
    };
  }, [overview.series, windowVersion, artifacts]);

  const latest = useMemo(() => {
    const out: LatestByMetric = {};
    for (const g of groups) {
      for (const metric of g.metrics) {
        const r = resolve(metric, playheadTs);
        if (r) out[metric] = r;
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolve, playheadTs, groupsKey]);

  // Route + traveled highlight come from the overview trace (session-wide);
  // the window trace only refines the marker near the playhead.
  const breakGapMs = options.breakGapMs ?? DEFAULT_BREAK_GAP_MS;
  const overviewTrace = useMemo(() => {
    const lat = overview.series.get("gps.lat");
    const breakMs = Math.max(breakGapMs, 3 * (lat?.bucketMs ?? 0));
    return buildTrace(lat, overview.series.get("gps.lon"), breakMs);
  }, [overview.series, breakGapMs]);

  const routeLines = useMemo(() => traceLines(overviewTrace), [overviewTrace]);

  const overviewSummary = useMemo(
    () => (timeline ? summarizeGpsSeries(overview.series, timeline.from, timeline.to, breakGapMs) : null),
    [overview.series, timeline, breakGapMs],
  );

  const windowTrace: GpsTrace | null = useMemo(() => {
    void windowVersion;
    const win = windowsRef.current.get(artifacts ? ARTIFACT_WINDOW_KEY : "gps");
    if (!win?.bounds) return null;
    return buildTrace(win.series.get("gps.lat"), win.series.get("gps.lon"), breakGapMs);
  }, [windowVersion, breakGapMs, artifacts]);

  const marker = useMemo(() => {
    const win = windowsRef.current.get(artifacts ? ARTIFACT_WINDOW_KEY : "gps");
    if (
      windowTrace &&
      windowTrace.pts.length > 0 &&
      win?.bounds &&
      playheadTs >= win.bounds.fromTs &&
      playheadTs <= win.bounds.toTs
    ) {
      return positionAt(windowTrace, playheadTs, MARKER_INTERP_MS, GROUP_STALENESS_MS.gps);
    }
    const bucketMs = overview.series.get("gps.lat")?.bucketMs ?? 0;
    return positionAt(
      overviewTrace,
      playheadTs,
      Math.max(MARKER_INTERP_MS, 2 * bucketMs),
      overviewStalenessMs("gps.lat", bucketMs),
    );
  }, [windowTrace, overviewTrace, playheadTs, overview.series, artifacts]);

  const traveled = useMemo(
    () => traveledLines(overviewTrace, playheadTs, marker?.pos ?? null),
    [overviewTrace, playheadTs, marker],
  );

  const courseReading = latest["gps.course"];

  return {
    latest,
    position: marker?.pos ?? null,
    course: typeof courseReading?.value === "number" ? courseReading.value : null,
    routeLines,
    traveledLines: traveled,
    hasGps: overviewTrace.pts.length > 0,
    loading: runKey !== null && (overview.loading || settledKey !== runKey),
    error: overview.error,
    source,
    overviewSummary,
  };
}
