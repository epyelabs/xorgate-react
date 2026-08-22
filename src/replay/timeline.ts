import type { ReplayGap, ReplaySegment, ReplaySession } from "@xorgate/sdk";

// Pure timeline math over one replay-manifest session: maps the wall-clock
// playhead (epoch ms) to segments and gaps. The manifest is the truth —
// segments arrive ordered by startTs with server-computed effectiveDurationMs
// and gaps; nothing here re-derives contiguity. All lookups are binary
// searches so a rAF-rate caller never scans arrays.

export interface ReplayTimeline {
  from: number;
  to: number;
  segments: ReplaySegment[];
  gaps: ReplayGap[];
  /**
   * Jump targets for the prev/next transport buttons: every segment start
   * plus every gap end (a gap's far side is where video resumes), sorted.
   */
  boundaries: number[];
  /** Wall-clock ends of crash-cut (`finalized: false`) segments. Scrubber ticks. */
  partialEnds: number[];
}

export function buildTimeline(
  session: Pick<ReplaySession, "segments" | "gaps">,
  from: number,
  to: number,
): ReplayTimeline {
  const segments = [...session.segments].sort((a, b) => a.startTs - b.startTs);
  const gaps = [...session.gaps].sort((a, b) => a.fromTs - b.fromTs);
  const bounds = new Set<number>();
  for (const s of segments) bounds.add(s.startTs);
  for (const g of gaps) bounds.add(g.toTs);
  const boundaries = [...bounds]
    .filter((ts) => ts >= from && ts <= to)
    .sort((a, b) => a - b);
  const partialEnds = segments.filter((s) => !s.finalized).map(segmentEnd);
  return { from, to, segments, gaps, boundaries, partialEnds };
}

/** `startTs + effectiveDurationMs`. */
export function segmentEnd(segment: ReplaySegment): number {
  return segment.startTs + segment.effectiveDurationMs;
}

/**
 * The segment covering ts (`[startTs, startTs + effectiveDurationMs)`), or
 * null when ts falls in a gap or outside all coverage. Binary search.
 */
export function segmentAt(
  timeline: ReplayTimeline,
  ts: number,
): { segment: ReplaySegment; offsetMs: number } | null {
  const { segments } = timeline;
  let lo = 0;
  let hi = segments.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const seg = segments[mid];
    if (ts < seg.startTs) hi = mid - 1;
    else if (ts >= segmentEnd(seg)) lo = mid + 1;
    else return { segment: seg, offsetMs: ts - seg.startTs };
  }
  return null;
}

export function hasCoverageAt(timeline: ReplayTimeline, ts: number): boolean {
  return segmentAt(timeline, ts) !== null;
}

/**
 * The manifest gap containing ts, if any. Uncovered stretches the server did
 * not call out (e.g. past an open session's last segment) return null — they
 * still free-run, they just are not skippable.
 */
export function gapAt(timeline: ReplayTimeline, ts: number): ReplayGap | null {
  for (const g of timeline.gaps) {
    if (ts >= g.fromTs && ts < g.toTs) return g;
    if (g.fromTs > ts) break;
  }
  return null;
}

/** First segment starting at or after ts (prefetch + far-side-of-gap resolution). */
export function nextSegmentAfter(
  timeline: ReplayTimeline,
  ts: number,
): ReplaySegment | null {
  const { segments } = timeline;
  let lo = 0;
  let hi = segments.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid].startTs < ts) lo = mid + 1;
    else hi = mid;
  }
  return segments[lo] ?? null;
}

// A small grace window makes repeated "prev" presses walk backwards instead
// of re-snapping to the boundary just behind the playhead.
const PREV_GRACE_MS = 1500;

export function prevBoundary(timeline: ReplayTimeline, ts: number): number {
  const { boundaries } = timeline;
  for (let i = boundaries.length - 1; i >= 0; i--) {
    if (boundaries[i] < ts - PREV_GRACE_MS) return boundaries[i];
  }
  return timeline.from;
}

export function nextBoundary(timeline: ReplayTimeline, ts: number): number {
  for (const b of timeline.boundaries) {
    if (b > ts) return b;
  }
  return timeline.to;
}

export function clampTs(timeline: ReplayTimeline, ts: number): number {
  return Math.min(Math.max(ts, timeline.from), timeline.to);
}
