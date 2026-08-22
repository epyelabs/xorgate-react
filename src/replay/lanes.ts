import type { ReplayGap, ReplayManifest, ReplaySegment, ReplaySession, StreamKey } from "@xorgate/sdk";
import { segmentEnd, type ReplayTimeline } from "./timeline.js";

// Composite lanes: a lane is one camera (streamKey) laid onto the shared
// wall-clock timeline. A range-mode manifest returns N sessions — several per
// streamKey when recording restarted — so lane assembly merges same-streamKey
// sessions onto one lane. Each lane keeps its OWN timeline (its video tile
// buffers, seeks and shows its "no video" state independently), while ONE
// merged clock timeline drives the transport bar, gap skipping and free-run:
// a clock gap is a stretch where NO lane has video. One camera missing while
// the other plays is a lane-level state, not a replay-level gap — the honesty
// rule the whole design rests on.

// A hole must exceed this to count as a gap — the server's timeline math uses
// the same threshold; smaller seams are absorbed by the player's micro-gap
// jump controller.
const GAP_MIN_MS = 2_000;

/**
 * A lane segment remembers its session: `seq` stops being unique the moment a
 * lane merges two sessions, since both start at seq 0.
 */
export interface LaneSegment extends ReplaySegment {
  sessionId: string;
}

/** One camera laid onto the shared wall clock. */
export interface ReplayLane {
  streamKey: StreamKey;
  /** Contributing sessions, ordered by first-segment start. */
  sessions: ReplaySession[];
  /** Lane-local, over the SHARED replay bounds. `segments` are `LaneSegment`s. */
  timeline: ReplayTimeline;
  /** Any contributing session recorded with an untrusted clock. */
  unsynced: boolean;
  hasPartial: boolean;
  open: boolean;
}

export function segmentUrlKey(sessionId: string, seq: number): string {
  return `${sessionId}:${seq}`;
}

interface Interval {
  fromTs: number;
  toTs: number;
}

// Union of segment coverage: overlapping/abutting intervals merge; holes stay
// (they become gaps or micro-seams depending on size).
function mergeCoverage(segments: readonly ReplaySegment[]): Interval[] {
  const sorted = [...segments].sort((a, b) => a.startTs - b.startTs);
  const runs: Interval[] = [];
  for (const s of sorted) {
    const end = segmentEnd(s);
    const last = runs[runs.length - 1];
    if (last && s.startTs <= last.toTs) {
      last.toTs = Math.max(last.toTs, end);
    } else {
      runs.push({ fromTs: s.startTs, toTs: end });
    }
  }
  return runs;
}

// Gaps = complement of coverage within [from, to], holes > GAP_MIN_MS only.
// Where a hole coincides with a server-reported gap, its reason survives
// (evicted-head); holes the server never saw are missing-segments.
function complementGaps(
  runs: Interval[],
  from: number,
  to: number,
  known: readonly ReplayGap[],
): ReplayGap[] {
  const reasonByStart = new Map(known.map((g) => [g.fromTs, g.reason]));
  const gaps: ReplayGap[] = [];
  let cursor = from;
  for (const r of runs) {
    if (r.fromTs - cursor > GAP_MIN_MS) {
      gaps.push({
        fromTs: cursor,
        toTs: r.fromTs,
        reason: reasonByStart.get(cursor) ?? "missing-segments",
      });
    }
    cursor = Math.max(cursor, r.toTs);
  }
  if (to - cursor > GAP_MIN_MS) {
    gaps.push({
      fromTs: cursor,
      toTs: to,
      reason: reasonByStart.get(cursor) ?? "missing-segments",
    });
  }
  return gaps;
}

function buildBoundaries(
  segmentStarts: Iterable<number>,
  gaps: readonly ReplayGap[],
  from: number,
  to: number,
): number[] {
  const bounds = new Set<number>();
  for (const ts of segmentStarts) bounds.add(ts);
  for (const g of gaps) if (g.toTs < to) bounds.add(g.toTs);
  return [...bounds].filter((ts) => ts >= from && ts <= to).sort((a, b) => a - b);
}

function buildLaneTimeline(
  sessions: readonly ReplaySession[],
  from: number,
  to: number,
): ReplayTimeline {
  const segments: LaneSegment[] = sessions
    .flatMap((s) => s.segments.map((seg) => ({ ...seg, sessionId: s.id })))
    .sort((a, b) => a.startTs - b.startTs);
  const known = sessions.flatMap((s) => s.gaps);
  const gaps = complementGaps(mergeCoverage(segments), from, to, known);
  return {
    from,
    to,
    segments,
    gaps,
    boundaries: buildBoundaries(
      segments.map((s) => s.startTs),
      gaps,
      from,
      to,
    ),
    partialEnds: segments.filter((s) => !s.finalized).map(segmentEnd),
  };
}

/**
 * Manifest to lanes, sorted by `streamKey` (deterministic tile order = pacer
 * election order). Same-`streamKey` sessions merge onto one lane; a session
 * with no surviving segments produces no lane, which is the telemetry-only
 * replay case rather than an error.
 */
export function buildLanes(manifest: ReplayManifest): ReplayLane[] {
  const byKey = new Map<string, ReplaySession[]>();
  for (const s of manifest.sessions) {
    if (s.segments.length === 0) continue;
    const list = byKey.get(s.streamKey);
    if (list) list.push(s);
    else byKey.set(s.streamKey, [s]);
  }
  return [...byKey.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([streamKey, sessions]) => {
      const ordered = [...sessions].sort(
        (a, b) => a.segments[0].startTs - b.segments[0].startTs,
      );
      return {
        streamKey,
        sessions: ordered,
        timeline: buildLaneTimeline(ordered, manifest.from, manifest.to),
        unsynced: ordered.some((s) => s.timeSource === "unsynced"),
        hasPartial: ordered.some((s) => s.segments.some((seg) => !seg.finalized)),
        open: ordered.some((s) => s.status === "open"),
      };
    });
}

/**
 * The clock's merged timeline. One lane passes through untouched (real
 * segments, exact single-session behaviour); N lanes merge into synthetic
 * coverage segments — the clock and transport bar only need "is there video
 * anywhere at ts", while boundaries keep every lane's real segment starts so
 * prev/next jumps still land on camera cuts.
 */
export function buildClockTimeline(
  lanes: readonly ReplayLane[],
  from: number,
  to: number,
): ReplayTimeline {
  if (lanes.length === 0) {
    // Telemetry-only replay: nothing to skip, the clock free-runs the span.
    return { from, to, segments: [], gaps: [], boundaries: [], partialEnds: [] };
  }
  if (lanes.length === 1) return lanes[0].timeline;

  const allSegments = lanes.flatMap((l) => l.timeline.segments);
  const runs = mergeCoverage(allSegments);
  const known = lanes.flatMap((l) => l.timeline.gaps);
  const gaps = complementGaps(runs, from, to, known);
  const segments: ReplaySegment[] = runs.map((r, i) => ({
    seq: i,
    startTs: r.fromTs,
    effectiveDurationMs: r.toTs - r.fromTs,
    finalized: true,
    anchor: null,
    sizeBytes: null,
    url: "",
  }));
  return {
    from,
    to,
    segments,
    gaps,
    boundaries: buildBoundaries(
      allSegments.map((s) => s.startTs),
      gaps,
      from,
      to,
    ),
    partialEnds: [...new Set(lanes.flatMap((l) => l.timeline.partialEnds))].sort(
      (a, b) => a - b,
    ),
  };
}
