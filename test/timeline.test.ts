import { describe, expect, it } from "vitest"
import type { ReplayGap, ReplaySegment } from "@xorgate/sdk"
import {
  buildTimeline,
  clampTs,
  gapAt,
  hasCoverageAt,
  nextBoundary,
  nextSegmentAfter,
  prevBoundary,
  segmentAt,
} from "../src/replay/timeline.js"

const T0 = 1_753_280_000_000

function seg(partial: Partial<ReplaySegment> & { seq: number; startTs: number }): ReplaySegment {
  return {
    effectiveDurationMs: 60_000,
    finalized: true,
    anchor: "boundary",
    sizeBytes: 14_000_000,
    url: `https://example.test/${partial.seq}.mp4`,
    ...partial,
  }
}

// Modeled on the real eviction fodder: three segments, a 180 s hole, then two
// more, with a crash-cut (finalized=false) tail.
const HOLE_GAP: ReplayGap = {
  fromTs: T0 + 180_000,
  toTs: T0 + 360_000,
  reason: "missing-segments",
}
const holeSession = {
  segments: [
    seg({ seq: 0, startTs: T0 }),
    seg({ seq: 1, startTs: T0 + 60_000 }),
    seg({ seq: 2, startTs: T0 + 120_000 }),
    seg({ seq: 5, startTs: T0 + 360_000 }),
    seg({ seq: 6, startTs: T0 + 420_000, finalized: false, effectiveDurationMs: 31_000 }),
  ],
  gaps: [HOLE_GAP],
}
const holeTl = buildTimeline(holeSession, T0, T0 + 451_000)

describe("buildTimeline", () => {
  it("sorts out-of-order segments by startTs", () => {
    const tl = buildTimeline(
      { segments: [holeSession.segments[2], holeSession.segments[0], holeSession.segments[1]], gaps: [] },
      T0,
      T0 + 180_000
    )
    expect(tl.segments.map((s) => s.seq)).toEqual([0, 1, 2])
  })

  it("boundaries = segment starts + gap ends, clipped to [from, to]", () => {
    expect(holeTl.boundaries).toEqual([
      T0,
      T0 + 60_000,
      T0 + 120_000,
      T0 + 360_000, // gap end == seq-5 start (deduped)
      T0 + 420_000,
    ])
  })

  it("handles an empty session (expired media, R6)", () => {
    const tl = buildTimeline({ segments: [], gaps: [] }, T0, T0 + 1000)
    expect(tl.boundaries).toEqual([])
    expect(segmentAt(tl, T0)).toBeNull()
    expect(nextSegmentAfter(tl, T0)).toBeNull()
  })
})

describe("segmentAt", () => {
  it("resolves ts inside a segment to (segment, offset)", () => {
    const hit = segmentAt(holeTl, T0 + 61_500)
    expect(hit?.segment.seq).toBe(1)
    expect(hit?.offsetMs).toBe(1_500)
  })

  it("segment start is inclusive, end exclusive (contiguity edge)", () => {
    expect(segmentAt(holeTl, T0 + 60_000)?.segment.seq).toBe(1)
    expect(segmentAt(holeTl, T0 + 59_999)?.segment.seq).toBe(0)
  })

  it("returns null inside the eviction hole", () => {
    expect(segmentAt(holeTl, T0 + 200_000)).toBeNull()
    expect(hasCoverageAt(holeTl, T0 + 200_000)).toBe(false)
  })

  it("crash-cut segment covers only its own durationMs", () => {
    expect(segmentAt(holeTl, T0 + 450_999)?.segment.seq).toBe(6)
    expect(segmentAt(holeTl, T0 + 451_000)).toBeNull()
  })
})

describe("gapAt", () => {
  it("finds the manifest gap containing ts (start inclusive, end exclusive)", () => {
    expect(gapAt(holeTl, T0 + 180_000)).toEqual(HOLE_GAP)
    expect(gapAt(holeTl, T0 + 359_999)).toEqual(HOLE_GAP)
    expect(gapAt(holeTl, T0 + 360_000)).toBeNull()
  })

  it("returns null for uncovered stretches that are not manifest gaps", () => {
    // Past the crash-cut tail: uncovered, but the server called out no gap.
    expect(gapAt(holeTl, T0 + 451_000)).toBeNull()
  })
})

describe("evicted-head leading gap", () => {
  const tl = buildTimeline(
    {
      segments: [seg({ seq: 3, startTs: T0 + 180_000 })],
      gaps: [{ fromTs: T0, toTs: T0 + 180_000, reason: "evicted-head" }],
    },
    T0,
    T0 + 240_000
  )

  it("replay starts inside the gap; first boundary is the gap end", () => {
    expect(gapAt(tl, T0)?.reason).toBe("evicted-head")
    expect(nextBoundary(tl, T0)).toBe(T0 + 180_000)
  })
})

describe("boundary jumps", () => {
  it("nextBoundary returns the next segment start / gap end, else to", () => {
    expect(nextBoundary(holeTl, T0 + 10_000)).toBe(T0 + 60_000)
    expect(nextBoundary(holeTl, T0 + 130_000)).toBe(T0 + 360_000)
    expect(nextBoundary(holeTl, T0 + 430_000)).toBe(holeTl.to)
  })

  it("prevBoundary walks backwards with a grace window", () => {
    // Just after seq-1's start: grace sends us to seq-0, not back to seq-1.
    expect(prevBoundary(holeTl, T0 + 61_000)).toBe(T0)
    // Well into seq-1: prev is seq-1's own start.
    expect(prevBoundary(holeTl, T0 + 90_000)).toBe(T0 + 60_000)
    // At the very start: clamps to from.
    expect(prevBoundary(holeTl, T0)).toBe(holeTl.from)
  })
})

describe("nextSegmentAfter / clampTs", () => {
  it("resolves the far side of the hole", () => {
    expect(nextSegmentAfter(holeTl, T0 + 200_000)?.seq).toBe(5)
    expect(nextSegmentAfter(holeTl, T0 + 421_000)).toBeNull()
  })

  it("clamps outside the replay span", () => {
    expect(clampTs(holeTl, T0 - 5)).toBe(T0)
    expect(clampTs(holeTl, holeTl.to + 5)).toBe(holeTl.to)
  })
})
