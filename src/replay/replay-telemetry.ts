import { XorgateError } from "@xorgate/sdk";
import type {
  LatestReading,
  MetricName,
  ReplayTelemetrySegment,
  TelemetryInsights,
  TelemetryReading,
} from "@xorgate/sdk";

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

// --- session artifacts (manifest `telemetry` block) --------------------------
// The replay manifest can hand out the recorded telemetry as presigned S3
// objects (telemetry-session-artifacts plan): one `overview.v1` object per
// telemetry session for the route line and the scrub preview, and the
// device's own 60 s JSONL segments for the raw window around the playhead.
// Everything below decodes those objects into the SAME `MetricSeries` shape
// `seriesFromReadings` produces, so `resolve`, `buildTrace` and `latestWithin`
// never learn which source fed them.
//
// No inflater, on purpose. Every artifact URL the manifest hands out carries
// `Content-Encoding: gzip` (overviews are written that way; raw segments are
// normalised at ingest), so `fetch(url).json()` / `fetch(url).text()` inflate
// natively in browsers, Node 18+, iOS and Android. React Native has no
// `DecompressionStream`, and this package ships no runtime dependency for it.

/** One metric group's grid inside an `overview.v1` object. */
export interface OverviewGroupV1 {
  /** Bucket width; the native sample period when no averaging happened. */
  bucketMs: number;
  /** SPARSE and ascending: only buckets that had data. A hole is a recording hole. */
  ts: number[];
  units: Record<string, string>;
  /** Positionally aligned with `ts`; `null` = metric absent in that bucket. */
  values: Record<string, (number | null)[]>;
  /** `[minLon, minLat, maxLon, maxLat]`; gps only, absent without a fix. */
  bbox?: [number, number, number, number];
}

/**
 * The precomputed per-session overview artifact (`format: "overview.v1"` on
 * the manifest). Additive fields keep `v: 1`; unknown keys are ignored.
 */
export interface OverviewV1 {
  v: 1;
  kind: "telemetry-overview";
  deviceId: string;
  sessionId: string;
  rateHz: number | null;
  /** Worst clock seen across the session's segments. */
  timeSource: string | null;
  /** First and last sample, epoch ms. */
  from: number;
  to: number;
  builtAt: number;
  source?: {
    segments: number;
    samples: number;
    bytes: number;
    [key: string]: unknown;
  };
  groups: Record<string, OverviewGroupV1>;
  insights: TelemetryInsights | null;
  [key: string]: unknown;
}

/** The header line of a raw telemetry segment. */
export interface SegmentHeader {
  v: number;
  deviceId: string;
  sessionId: string;
  bootId?: string;
  timeSource?: string;
  rateHz?: number;
  startedAt?: number;
  [key: string]: unknown;
}

/** A raw segment decoded into per-metric series. */
export interface DecodedSegment {
  series: Map<MetricName, MetricSeries>;
  /** First and last sample IN THE FILE, or null for a segment with no valid sample. */
  fromTs: number | null;
  toTs: number | null;
  samples: number;
  /** Lines that were neither a header nor a valid sample. */
  invalidLines: number;
  header: SegmentHeader | null;
}

/**
 * The cache identity of an artifact: its S3 key, i.e. the URL without the
 * presigned query string. A manifest refresh changes the signature and never
 * the object, so a cache keyed this way survives it.
 */
export function artifactKey(url: string): string {
  const q = url.indexOf("?");
  const path = q === -1 ? url : url.slice(0, q);
  const scheme = path.indexOf("://");
  if (scheme === -1) return path;
  const slash = path.indexOf("/", scheme + 3);
  return slash === -1 ? path : path.slice(slash + 1);
}

/**
 * The overview object as per-metric series, `bucketMs` from its group, units
 * from the object. Null buckets are dropped, so a series holds only the
 * buckets that carried the metric, exactly as the interval-averaged REST
 * response did.
 */
export function overviewToSeries(obj: OverviewV1): Map<MetricName, MetricSeries> {
  const out = new Map<MetricName, MetricSeries>();
  const groups = obj.groups ?? {};
  for (const name of Object.keys(groups)) {
    const group = groups[name];
    if (!group || !Array.isArray(group.ts)) continue;
    const values = group.values ?? {};
    for (const metric of Object.keys(values)) {
      const column = values[metric];
      if (!Array.isArray(column)) continue;
      const s: MetricSeries = {
        ts: [],
        v: [],
        unit: group.units?.[metric] ?? null,
        bucketMs: group.bucketMs,
      };
      const n = Math.min(column.length, group.ts.length);
      for (let i = 0; i < n; i++) {
        const v = column[i];
        if (typeof v !== "number" || !Number.isFinite(v)) continue;
        s.ts.push(group.ts[i]);
        s.v.push(v);
      }
      if (s.ts.length > 0) out.set(metric as MetricName, s);
    }
  }
  return out;
}

/** The `insights` block of an overview, or null when the builder wrote none. */
export function insightsFromOverview(obj: OverviewV1): TelemetryInsights | null {
  const insights = obj.insights;
  return insights && typeof insights === "object" ? insights : null;
}

const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;

/**
 * A raw segment (plain JSONL: one header line, then one `{ ts, mono, seq,
 * metrics }` sample per line) as per-metric RAW series (`bucketMs: null`).
 * Metrics are `group.field` from the nested object; a leaf is `{ value, unit }`
 * and only finite numeric values are kept. Lines that fail to parse are
 * counted, not thrown.
 *
 * ONE defensive check: a body that still starts with the gzip magic bytes was
 * served without `Content-Encoding: gzip`. That is an un-normalised object in
 * a manifest, a backend defect, and it throws a typed `INVALID_RESPONSE`
 * naming the key rather than being papered over client-side.
 */
export function segmentToSeries(text: string, key = "segment"): DecodedSegment {
  if (text.length >= 2 && text.charCodeAt(0) === GZIP_MAGIC_0 && text.charCodeAt(1) === GZIP_MAGIC_1) {
    throw new XorgateError({
      code: "INVALID_RESPONSE",
      message:
        `Telemetry segment ${key} arrived gzip-compressed without ` +
        "Content-Encoding: gzip (an un-normalised object in the manifest).",
      details: { key },
    });
  }
  const out = new Map<MetricName, MetricSeries>();
  let header: SegmentHeader | null = null;
  let fromTs: number | null = null;
  let toTs: number | null = null;
  let samples = 0;
  let invalidLines = 0;
  let unsorted = false;
  let start = 0;
  const len = text.length;
  while (start < len) {
    let end = text.indexOf("\n", start);
    if (end === -1) end = len;
    const line = text.slice(start, end).trim();
    start = end + 1;
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      invalidLines++;
      continue;
    }
    if (!parsed || typeof parsed !== "object") {
      invalidLines++;
      continue;
    }
    const rec = parsed as Record<string, unknown>;
    if (rec.type === "header") {
      if (!header) header = rec as unknown as SegmentHeader;
      continue;
    }
    const ts = rec.ts;
    const metrics = rec.metrics;
    if (typeof ts !== "number" || !Number.isFinite(ts) || !metrics || typeof metrics !== "object") {
      invalidLines++;
      continue;
    }
    samples++;
    if (fromTs === null || ts < fromTs) fromTs = ts;
    if (toTs === null || ts > toTs) toTs = ts;
    for (const group of Object.keys(metrics as Record<string, unknown>)) {
      const fields = (metrics as Record<string, unknown>)[group];
      if (!fields || typeof fields !== "object") continue;
      for (const field of Object.keys(fields as Record<string, unknown>)) {
        const leaf = (fields as Record<string, unknown>)[field];
        if (!leaf || typeof leaf !== "object") continue;
        const value = (leaf as { value?: unknown }).value;
        if (typeof value !== "number" || !Number.isFinite(value)) continue;
        const metric = `${group}.${field}` as MetricName;
        let s = out.get(metric);
        if (!s) {
          s = { ts: [], v: [], unit: null, bucketMs: null };
          out.set(metric, s);
        }
        if (s.ts.length > 0 && ts < s.ts[s.ts.length - 1]) unsorted = true;
        s.ts.push(ts);
        s.v.push(value);
        if (s.unit === null) {
          const unit = (leaf as { unit?: unknown }).unit;
          if (typeof unit === "string" && unit.length > 0) s.unit = unit;
        }
      }
    }
  }
  if (unsorted) sortSeriesInPlace(out);
  return { series: out, fromTs, toTs, samples, invalidLines, header };
}

function sortSeriesInPlace(map: Map<MetricName, MetricSeries>): void {
  for (const s of map.values()) {
    const idx = s.ts.map((_, i) => i).sort((a, b) => s.ts[a] - s.ts[b]);
    s.ts = idx.map((i) => s.ts[i]);
    s.v = idx.map((i) => s.v[i]);
  }
}

/**
 * Concatenate per-metric series from several sources (segments of one
 * session, or several sessions) into one ascending series per metric. Parts
 * are expected in time order (the manifest lists segments by `startTs` and
 * sessions by `from`); a defensive sort runs only if that ever stops holding.
 * `unit` comes from the first part that carries the metric; `bucketMs` is
 * the widest across the parts.
 */
export function mergeSeries(
  parts: Iterable<ReadonlyMap<MetricName, MetricSeries>>,
): Map<MetricName, MetricSeries> {
  const out = new Map<MetricName, MetricSeries>();
  let unsorted = false;
  for (const part of parts) {
    for (const [metric, s] of part) {
      let target = out.get(metric);
      if (!target) {
        target = { ts: [], v: [], unit: s.unit, bucketMs: s.bucketMs };
        out.set(metric, target);
      } else if (s.bucketMs !== null && (target.bucketMs === null || s.bucketMs > target.bucketMs)) {
        // The widest bucket wins, so the overview staleness cutoff is never
        // narrower than the coarsest part (a closed session's 15 s buckets
        // next to an open session's raw samples).
        target.bucketMs = s.bucketMs;
      }
      if (target.ts.length > 0 && s.ts.length > 0 && s.ts[0] < target.ts[target.ts.length - 1]) {
        unsorted = true;
      }
      for (let i = 0; i < s.ts.length; i++) {
        target.ts.push(s.ts[i]);
        target.v.push(s.v[i]);
      }
      if (target.unit === null && s.unit) target.unit = s.unit;
    }
  }
  if (unsorted) sortSeriesInPlace(out);
  return out;
}

// The server's overview builder uses this package's own interval ladder and
// targets (README D2): GPS finer, everything else coarser.
export const OVERVIEW_GPS_TARGET_BUCKETS = 2_000;
export const OVERVIEW_DEFAULT_TARGET_BUCKETS = 500;
const AVG_DECIMALS = 6;

/** The ladder rung (ms) for a group above its target: the smallest step whose bucket count fits. */
export function chooseBucketMs(spanMs: number, targetBuckets: number): number {
  const spanS = Math.max(1, Math.ceil(spanMs / 1000));
  for (const s of INTERVAL_LADDER) {
    if (Math.ceil(spanS / s) <= targetBuckets) return s * 1000;
  }
  return INTERVAL_LADDER[INTERVAL_LADDER.length - 1] * 1000;
}

/**
 * Build an overview from raw series the way the server would have: per
 * metric GROUP, keep the samples as they are while the group has no more
 * than its target (the native period, no averaging), else bucket-average at
 * the ladder rung that fits the group's span. Bucket `ts` is the bucket
 * start, so lat and lon of one group still pair by exact ts. This is the
 * open-session path (README D6): the manifest lists no `overview` until the
 * session closes, and the client builds one from the segments it was handed.
 */
export function buildOverviewSeries(
  raw: ReadonlyMap<MetricName, MetricSeries>,
): Map<MetricName, MetricSeries> {
  const byGroup = new Map<string, MetricName[]>();
  for (const metric of raw.keys()) {
    const g = metricGroup(metric);
    const list = byGroup.get(g);
    if (list) list.push(metric);
    else byGroup.set(g, [metric]);
  }
  const out = new Map<MetricName, MetricSeries>();
  for (const [group, metrics] of byGroup) {
    let first = Infinity;
    let last = -Infinity;
    let count = 0;
    for (const metric of metrics) {
      const s = raw.get(metric)!;
      if (s.ts.length === 0) continue;
      if (s.ts[0] < first) first = s.ts[0];
      if (s.ts[s.ts.length - 1] > last) last = s.ts[s.ts.length - 1];
      if (s.ts.length > count) count = s.ts.length;
    }
    const target = group === "gps" ? OVERVIEW_GPS_TARGET_BUCKETS : OVERVIEW_DEFAULT_TARGET_BUCKETS;
    if (count <= target) {
      for (const metric of metrics) out.set(metric, raw.get(metric)!);
      continue;
    }
    const bucketMs = chooseBucketMs(Math.max(1, last - first), target);
    for (const metric of metrics) {
      const s = raw.get(metric)!;
      const b: MetricSeries = { ts: [], v: [], unit: s.unit, bucketMs };
      let bucketStart = NaN;
      let sum = 0;
      let n = 0;
      const flush = () => {
        if (n === 0) return;
        const avg = sum / n;
        b.ts.push(bucketStart);
        b.v.push(n === 1 ? avg : Number(avg.toFixed(AVG_DECIMALS)));
      };
      for (let i = 0; i < s.ts.length; i++) {
        const start = Math.floor(s.ts[i] / bucketMs) * bucketMs;
        if (start !== bucketStart) {
          flush();
          bucketStart = start;
          sum = 0;
          n = 0;
        }
        sum += s.v[i];
        n++;
      }
      flush();
      out.set(metric, b);
    }
  }
  return out;
}

/**
 * The segments whose `[startTs, endTs]` overlap `[fromTs, toTs]`, in
 * `startTs` order across every session, plus the first segment starting
 * after `toTs` when `prefetch` is set (so the next one is warm before the
 * playhead reaches it). Segment bounds are the first and last sample IN THE
 * FILE, so one file can span a recording hole; that is fine here, the raw
 * lines inside say where the data really is.
 */
export function segmentsCovering<T extends Pick<ReplayTelemetrySegment, "startTs" | "endTs">>(
  segments: readonly T[],
  fromTs: number,
  toTs: number,
  prefetch = false,
): T[] {
  const out: T[] = [];
  let next: T | null = null;
  for (const seg of segments) {
    if (seg.endTs >= fromTs && seg.startTs <= toTs) out.push(seg);
    else if (prefetch && seg.startTs > toTs && (next === null || seg.startTs < next.startTs)) {
      next = seg;
    }
  }
  if (next) out.push(next);
  return out;
}
