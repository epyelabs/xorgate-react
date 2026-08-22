import { useEffect, useMemo, useRef, useState } from "react";
import { XorgateError } from "@xorgate/sdk";
import type { LatestByMetric, MetricName, TelemetryHistory } from "@xorgate/sdk";
import { declaredMetrics } from "@xorgate/sdk";
import { useXorgateContext } from "../context.js";
import type { UseTelemetryHistoryParams } from "../query/hooks.js";
import type { UseReplayPlayer } from "./use-replay-player.js";
import {
  buildTrace,
  chooseIntervalSeconds,
  latestWithin,
  metricGroup,
  overviewStalenessMs,
  positionAt,
  seriesFromReadings,
  stalenessMs,
  traceLines,
  traveledLines,
  windowBoundsFor,
  windowNeedsRefetch,
  DEFAULT_STALENESS_MS,
  GROUP_STALENESS_MS,
  WINDOW_MIN_SPAN_MS,
  WINDOW_SPAN_MS,
  type GpsTrace,
  type MetricSeries,
  type WindowBounds,
} from "./replay-telemetry.js";

// Overview bucket targets: fine for GPS (the trace is drawn from it), coarse
// for the rest (scrub preview only — the window tier supplies fidelity).
const OVERVIEW_GPS_TARGET_BUCKETS = 2_000;
const OVERVIEW_DEFAULT_TARGET_BUCKETS = 500;
// Pre-roll so a floor sample exists right at the replay start even for the
// slowest group (lte's ~15-20 s effective cadence).
const OVERVIEW_PREROLL_MS = 60_000;
// Marker interpolation only bridges near-adjacent fixes; anything wider
// holds, then hides via staleness.
const MARKER_INTERP_MS = 3_000;
// Back off failed window fetches briefly so an outage does not hammer the API
// at snapshot rate.
const WINDOW_ERROR_BACKOFF_MS = 5_000;
/** Route-break floor when the caller does not override it. */
const DEFAULT_BREAK_GAP_MS = 30_000;

/** The small fallback set when neither `metrics` nor a device model is reachable. */
const FALLBACK_METRICS: MetricName[] = [
  "gps.lat",
  "gps.lon",
  "gps.speed",
  "gps.course",
  "system.cpu_temp",
  "system.cpu_usage",
];

export interface UseReplayTelemetryOptions {
  /**
   * Metrics to fetch. Defaults to everything the device model declares when a
   * REST credential is available, else a small default set.
   */
  metrics?: MetricName[];
  /** High-resolution window around the playhead. Default 120000. */
  windowSpanMs?: number;
  /** Consecutive-fix gap that breaks the route polyline. Default 30000. */
  breakGapMs?: number;
  /**
   * How telemetry history is fetched. Defaults to the REST client. A PROXIED
   * consumer (browser holds no xorgate REST credential) points this at its
   * own backend, which relays `GET /devices/{id}/telemetry` with its API key.
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
  error: XorgateError | null;
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
}

/**
 * Telemetry for a replay, in two tiers: one coarse interval-averaged pass over
 * the whole window for the route and the scrub preview, plus a raw
 * high-resolution window that follows the playhead with hysteresis.
 */
export function useReplayTelemetry(
  deviceId: string | null,
  player: UseReplayPlayer,
  options: UseReplayTelemetryOptions = {},
): UseReplayTelemetry {
  const ctx = useXorgateContext();
  const timeline = player.timeline;
  const playheadTs = player.playheadTs || timeline?.from || 0;

  const optionMetricsKey = options.metrics?.join(",") ?? "";
  const fetchTelemetryRef = useRef(options.fetchTelemetry);
  fetchTelemetryRef.current = options.fetchTelemetry;
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

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

  // --- metric groups -------------------------------------------------------
  const [resolvedMetrics, setResolvedMetrics] = useState<MetricName[] | null>(null);
  useEffect(() => {
    if (options.metrics && options.metrics.length > 0) {
      setResolvedMetrics(options.metrics);
      return;
    }
    if (!deviceId) return;
    // Everything the device model declares, when REST can reach it; else the
    // fallback set. A proxied consumer passes `metrics` explicitly instead.
    const rest = ctxRef.current.rest;
    if (rest.kind !== "ready" && !fetchTelemetryRef.current) return;
    if (rest.kind !== "ready") {
      setResolvedMetrics(FALLBACK_METRICS);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const device = await rest.client.devices.get(deviceId);
        const model = await rest.client.deviceModels.get(device.deviceModelId);
        if (cancelled) return;
        const declared = declaredMetrics(model);
        setResolvedMetrics(declared.length > 0 ? declared : FALLBACK_METRICS);
      } catch {
        if (!cancelled) setResolvedMetrics(FALLBACK_METRICS);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId, optionMetricsKey]);

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

  // --- overview tier (once per replay) -------------------------------------
  const [overview, setOverview] = useState<{
    series: Map<MetricName, MetricSeries>;
    loading: boolean;
    error: XorgateError | null;
  }>({ series: new Map(), loading: false, error: null });

  useEffect(() => {
    if (!deviceId || !timeline || groups.length === 0) return;
    let cancelled = false;
    setOverview({ series: new Map(), loading: true, error: null });
    const spanMs = timeline.to - timeline.from;
    void (async () => {
      try {
        const fromIso = new Date(timeline.from - OVERVIEW_PREROLL_MS).toISOString();
        const toIso = new Date(timeline.to + 2_000).toISOString();
        const parts = await Promise.all(
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
        for (const part of parts) {
          for (const [metric, s] of part) series.set(metric, s);
        }
        setOverview({ series, loading: false, error: null });
      } catch (err) {
        if (cancelled) return;
        const mapped =
          err instanceof XorgateError
            ? err
            : new XorgateError({ code: "NETWORK", message: (err as Error).message });
        setOverview({ series: new Map(), loading: false, error: mapped });
        ctxRef.current.reportError(mapped);
      }
    })();
    return () => {
      cancelled = true;
    };
    // groupsKey stands in for the groups array identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId, timeline, groupsKey, fetchHistory]);

  // --- high-res window tier (hysteresis around the playhead) ---------------
  const windowsRef = useRef(new Map<string, GroupWindow>());
  const generationRef = useRef(0);
  const [windowVersion, setWindowVersion] = useState(0);
  const windowSpanMs = options.windowSpanMs ?? WINDOW_SPAN_MS;

  // New replay (or metric set): drop all windows and invalidate in-flight
  // fetches from the previous one.
  useEffect(() => {
    generationRef.current++;
    windowsRef.current = new Map();
    setWindowVersion((v) => v + 1);
  }, [deviceId, timeline, groupsKey]);

  useEffect(() => {
    if (!deviceId || !timeline || groups.length === 0) return;
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
  }, [deviceId, timeline, groupsKey, playheadTs, windowVersion, windowSpanMs, fetchHistory]);

  // --- derivations (all O(log n), at the ≤10 Hz snapshot rate) -------------

  // Nearest sample ≤ playhead: the raw window is the truth while the playhead
  // is inside its bounds (absent there = a real recording hole); elsewhere the
  // bucketed overview answers with a widened cutoff.
  const resolve = useMemo(() => {
    void windowVersion;
    const windows = windowsRef.current;
    const overviewSeries = overview.series;
    return (metric: MetricName, ts: number) => {
      const win = windows.get(metricGroup(metric));
      if (win?.bounds && ts >= win.bounds.fromTs && ts <= win.bounds.toTs) {
        const s = win.series.get(metric);
        return s ? latestWithin(metric, s, ts, stalenessMs(metric)) : null;
      }
      const s = overviewSeries.get(metric);
      if (!s) return null;
      return latestWithin(metric, s, ts, overviewStalenessMs(metric, s.bucketMs ?? 0));
    };
  }, [overview.series, windowVersion]);

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

  const windowTrace: GpsTrace | null = useMemo(() => {
    void windowVersion;
    const win = windowsRef.current.get("gps");
    if (!win?.bounds) return null;
    return buildTrace(win.series.get("gps.lat"), win.series.get("gps.lon"), breakGapMs);
  }, [windowVersion, breakGapMs]);

  const marker = useMemo(() => {
    const win = windowsRef.current.get("gps");
    if (
      windowTrace &&
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
  }, [windowTrace, overviewTrace, playheadTs, overview.series]);

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
    loading: overview.loading,
    error: overview.error,
  };
}
