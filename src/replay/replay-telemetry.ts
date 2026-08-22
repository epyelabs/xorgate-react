import type { LatestReading, MetricName, TelemetryReading } from "@xorgate/sdk";

// Pure telemetry math for replay: turns flat `{ts, metric, value}` readings
// into per-metric sorted series and resolves latest-at-playhead / GPS
// derivations with binary searches, so the ~10 Hz clock-driven callers never
// scan arrays. Two callers feed it: the session-wide downsampled overview and
// the high-res raw window around the playhead (use-replay-telemetry owns the
// fetching and hysteresis).

// --- staleness ---------------------------------------------------------------
// Nearest sample ≤ playhead counts only while younger than its group's cutoff;
// older → the metric is ABSENT from `latest` (views render their placeholder).
// This mirrors the recorder's freshness gating: a group stops producing rows
// the moment its source stops updating, so a hole in the rows is a genuine
// recording hole — never interpolate across it. Cutoffs are sized from native
// cadences measured on real hardware.
export const GROUP_STALENESS_MS: Record<string, number> = {
  imu: 2_500,
  gps: 5_000,
  system: 10_000,
  lte: 60_000,
};
export const DEFAULT_STALENESS_MS = 30_000;

export function metricGroup(metric: MetricName): string {
  const dot = metric.indexOf(".");
  return dot === -1 ? metric : metric.slice(0, dot);
}

export function stalenessMs(metric: MetricName): number {
  return GROUP_STALENESS_MS[metricGroup(metric)] ?? DEFAULT_STALENESS_MS;
}

/**
 * Overview buckets are interval-averaged, so their effective cadence is the
 * bucket length — widen the cutoff so coarse buckets do not flap, while real
 * holes (≫ bucket) still blank honestly.
 */
export function overviewStalenessMs(metric: MetricName, bucketMs: number): number {
  return Math.max(stalenessMs(metric), 2.5 * bucketMs);
}

// --- series ------------------------------------------------------------------

export interface MetricSeries {
  /** Ascending epoch ms, parallel to `v`. */
  ts: number[];
  v: number[];
  unit: string | null;
  /** Bucket width for interval-averaged series; null for raw rows. */
  bucketMs: number | null;
}

/**
 * Pivot flat API readings into per-metric sorted series. The server returns
 * rows ordered (ts asc, metric asc), so per-metric order is already ascending;
 * a defensive sort runs only if that ever stops holding. Null values (empty
 * buckets) are dropped.
 */
export function seriesFromReadings(
  readings: readonly TelemetryReading[],
  bucketSeconds: number | null,
): Map<MetricName, MetricSeries> {
  const out = new Map<MetricName, MetricSeries>();
  const bucketMs = bucketSeconds === null ? null : bucketSeconds * 1000;
  let unsorted = false;
  for (const r of readings) {
    if (r.value === null) continue;
    const ts = Date.parse(r.ts);
    if (Number.isNaN(ts)) continue;
    let s = out.get(r.metric);
    if (!s) {
      s = { ts: [], v: [], unit: null, bucketMs };
      out.set(r.metric, s);
    }
    if (s.ts.length > 0 && ts < s.ts[s.ts.length - 1]) unsorted = true;
    s.ts.push(ts);
    s.v.push(r.value);
    if (s.unit === null && r.unit) s.unit = r.unit;
  }
  if (unsorted) {
    for (const s of out.values()) {
      const idx = s.ts.map((_, i) => i).sort((a, b) => s.ts[a] - s.ts[b]);
      s.ts = idx.map((i) => s.ts[i]);
      s.v = idx.map((i) => s.v[i]);
    }
  }
  return out;
}

/** Rightmost index whose ts is at or below `target`, or -1. Binary search. */
export function floorIndex(ts: readonly number[], target: number): number {
  let lo = 0;
  let hi = ts.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] <= target) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/**
 * Nearest sample at or before `ts`, in the interop `LatestReading` shape, or
 * null when the nearest sample is older than `maxAgeMs`. Dropping a stale
 * sample rather than holding it is the point: a hole is a genuine recording
 * hole. Never interpolate across one.
 */
export function latestWithin(
  metric: MetricName,
  series: MetricSeries,
  ts: number,
  maxAgeMs: number,
): LatestReading | null {
  const i = floorIndex(series.ts, ts);
  if (i === -1) return null;
  if (ts - series.ts[i] > maxAgeMs) return null;
  return {
    metric,
    value: series.v[i],
    unit: series.unit,
    ts: new Date(series.ts[i]).toISOString(),
  };
}

// --- overview interval selection ---------------------------------------------

// Human-friendly interval steps; the server accepts 1–86400 s.
const INTERVAL_LADDER = [
  1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400, 28800, 86400,
];
// Server caps: ≤ 5000 buckets per metric and ≤ 10000 rows per response.
const SERVER_MAX_BUCKETS = 5_000;
const SERVER_MAX_ROWS = 10_000;

/**
 * Smallest sane interval whose bucket count fits the server caps (5,000
 * buckets per metric, 10,000 rows per response) and your own target.
 */
export function chooseIntervalSeconds(
  spanMs: number,
  metricCount: number,
  targetBuckets: number,
): number {
  const maxBuckets = Math.min(
    targetBuckets,
    Math.floor(SERVER_MAX_ROWS / Math.max(1, metricCount)),
    SERVER_MAX_BUCKETS,
  );
  const spanS = Math.max(1, Math.ceil(spanMs / 1000));
  for (const s of INTERVAL_LADDER) {
    if (Math.ceil(spanS / s) <= maxBuckets) return s;
  }
  return INTERVAL_LADDER[INTERVAL_LADDER.length - 1];
}

// --- high-res window sizing / hysteresis -------------------------------------

export const WINDOW_SPAN_MS = 120_000;
// Halved on `truncated` responses; never below this floor.
export const WINDOW_MIN_SPAN_MS = 30_000;

export interface WindowBounds {
  fromTs: number;
  toTs: number;
}

/**
 * Centre a high-resolution window on the playhead, sliding rather than
 * shrinking at the replay edges so edge windows keep their full span.
 */
export function windowBoundsFor(
  playheadTs: number,
  spanMs: number,
  replayFrom: number,
  replayTo: number,
): WindowBounds {
  const span = Math.min(spanMs, replayTo - replayFrom);
  let fromTs = playheadTs - span / 2;
  if (fromTs < replayFrom) fromTs = replayFrom;
  if (fromTs + span > replayTo) fromTs = replayTo - span;
  return { fromTs, toTs: fromTs + span };
}

/**
 * Hysteresis: refetch when the playhead leaves the middle half of the current
 * window, but only if a refetch would actually move it. Without the second
 * test an off-centre playhead at a replay edge loops forever.
 */
export function windowNeedsRefetch(
  win: WindowBounds | null,
  playheadTs: number,
  spanMs: number,
  replayFrom: number,
  replayTo: number,
): boolean {
  if (!win) return true;
  const desired = windowBoundsFor(playheadTs, spanMs, replayFrom, replayTo);
  if (desired.fromTs === win.fromTs && desired.toTs === win.toTs) return false;
  const half = (win.toTs - win.fromTs) / 2;
  const center = win.fromTs + half;
  return Math.abs(playheadTs - center) > half / 2;
}

// --- GPS trace / marker ------------------------------------------------------

export interface GpsTrace {
  /** `[lon, lat]` per point, chronological, parallel to `ts`. */
  pts: [number, number][];
  ts: number[];
  /** Indexes where a new polyline starts. Index 0 is implicit and never listed. */
  breaks: number[];
}

/**
 * Zip lat and lon series into one chronological trace. Points pair by EXACT
 * ts — raw rows from one sample line and overview buckets from one call both
 * share timestamps, so a two-pointer walk suffices; unmatched samples drop.
 */
export function buildTrace(
  lat: MetricSeries | undefined,
  lon: MetricSeries | undefined,
  breakGapMs: number,
): GpsTrace {
  const trace: GpsTrace = { pts: [], ts: [], breaks: [] };
  if (!lat || !lon) return trace;
  let i = 0;
  let j = 0;
  while (i < lat.ts.length && j < lon.ts.length) {
    if (lat.ts[i] < lon.ts[j]) i++;
    else if (lat.ts[i] > lon.ts[j]) j++;
    else {
      const ts = lat.ts[i];
      if (trace.ts.length > 0 && ts - trace.ts[trace.ts.length - 1] > breakGapMs) {
        trace.breaks.push(trace.ts.length);
      }
      trace.pts.push([lon.v[j], lat.v[i]]);
      trace.ts.push(ts);
      i++;
      j++;
    }
  }
  return trace;
}

/**
 * Split a trace into polylines at its break indexes; lines shorter than 2
 * points cannot render as lines and are dropped (the marker covers them).
 */
export function traceLines(trace: GpsTrace): [number, number][][] {
  return sliceLines(trace, trace.pts.length - 1, null);
}

/**
 * The traveled portion: polylines clipped at the playhead's floor point, with
 * the (interpolated) marker position appended so the highlight meets the
 * marker instead of trailing a sample behind it.
 */
export function traveledLines(
  trace: GpsTrace,
  playheadTs: number,
  markerPos: [number, number] | null,
): [number, number][][] {
  const last = floorIndex(trace.ts, playheadTs);
  if (last === -1) return [];
  return sliceLines(trace, last, markerPos);
}

function sliceLines(
  trace: GpsTrace,
  lastIndex: number,
  appendPos: [number, number] | null,
): [number, number][][] {
  const lines: [number, number][][] = [];
  let start = 0;
  for (const b of trace.breaks) {
    if (b > lastIndex) break;
    if (b - start >= 2) lines.push(trace.pts.slice(start, b));
    start = b;
  }
  const tail = trace.pts.slice(start, lastIndex + 1);
  // Only extend the tail line to the marker when the marker is actually live —
  // a null marker means the playhead left coverage.
  if (appendPos && tail.length >= 1) tail.push(appendPos);
  if (tail.length >= 2) lines.push(tail);
  return lines;
}

export interface PositionResolution {
  pos: [number, number];
  interpolated: boolean;
}

/**
 * Marker position at the playhead: linear interpolation between the
 * bracketing fixes when they are close enough (≤ maxInterpGapMs and not
 * across a trace break), else the floor fix while it is fresh (≤ maxAgeMs),
 * else null — a GPS hole HIDES the marker rather than freezing it somewhere
 * wrong.
 */
export function positionAt(
  trace: GpsTrace,
  playheadTs: number,
  maxInterpGapMs: number,
  maxAgeMs: number,
): PositionResolution | null {
  const i = floorIndex(trace.ts, playheadTs);
  if (i === -1) return null;
  const t0 = trace.ts[i];
  const next = i + 1;
  if (
    next < trace.ts.length &&
    !trace.breaks.includes(next) &&
    trace.ts[next] - t0 <= maxInterpGapMs
  ) {
    const t1 = trace.ts[next];
    const f = (playheadTs - t0) / (t1 - t0);
    const [lon0, lat0] = trace.pts[i];
    const [lon1, lat1] = trace.pts[next];
    return {
      pos: [lon0 + (lon1 - lon0) * f, lat0 + (lat1 - lat0) * f],
      interpolated: true,
    };
  }
  if (playheadTs - t0 > maxAgeMs) return null;
  return { pos: trace.pts[i], interpolated: false };
}
