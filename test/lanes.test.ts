import { describe, expect, it } from "vitest"
import type { ReplayManifest, ReplaySegment, ReplaySession } from "@xorgate/sdk"
import {
  buildClockTimeline,
  buildLanes,
  segmentUrlKey,
  type LaneSegment,
} from "../src/replay/lanes.js"
import { hasCoverageAt } from "../src/replay/timeline.js"

const T0 = 1_753_280_000_000

function seg(
  partial: Partial<ReplaySegment> & { seq: number; startTs: number }
): ReplaySegment {
  return {
    effectiveDurationMs: 60_000,
    finalized: true,
    anchor: "boundary",
    sizeBytes: 14_000_000,
    url: `https://example.test/${partial.seq}.mp4`,
    ...partial,
  }
}

function sess(
  partial: Partial<ReplaySession> & { id: string; segments: ReplaySegment[] }
): ReplaySession {
  return {
    streamKey: "cam0",
    status: "closed",
    timeSource: "ntp",
    codec: "h264",
    width: 1920,
    height: 1080,
    fps: 15,
    gaps: [],
    ...partial,
  }
}

function manifest(
  sessions: ReplaySession[],
  from: number,
  to: number
): ReplayManifest {
  return { deviceId: "dev-1", from, to, sessions, urlExpiresAt: 0 }
}

describe("buildLanes — single session (Phase 3/4 compatibility)", () => {
  // Mirrors the eviction fodder: 180 s interior hole reported by the server,
  // plus an evicted head.
  const s = sess({
    id: "s-1",
    segments: [
      seg({ seq: 3, startTs: T0 + 120_000 }),
      seg({ seq: 4, startTs: T0 + 180_000 }),
      seg({ seq: 8, startTs: T0 + 420_000 }),
    ],
    gaps: [
      { fromTs: T0, toTs: T0 + 120_000, reason: "evicted-head" },
      { fromTs: T0 + 240_000, toTs: T0 + 420_000, reason: "missing-segments" },
    ],
  })
  const m = manifest([s], T0, T0 + 480_000)
  const lanes = buildLanes(m)
  const clockTl = buildClockTimeline(lanes, m.from, m.to)

  it("one session → one lane; clock timeline IS the lane timeline", () => {
    expect(lanes).toHaveLength(1)
    expect(clockTl).toBe(lanes[0].timeline)
    expect(clockTl.segments.map((x) => x.seq)).toEqual([3, 4, 8])
  })

  it("reproduces the server's gaps, reasons included", () => {
    expect(clockTl.gaps).toEqual([
      { fromTs: T0, toTs: T0 + 120_000, reason: "evicted-head" },
      { fromTs: T0 + 240_000, toTs: T0 + 420_000, reason: "missing-segments" },
    ])
  })

  it("lane segments carry their sessionId (URL-map key)", () => {
    const first = clockTl.segments[0] as LaneSegment
    expect(first.sessionId).toBe("s-1")
    expect(segmentUrlKey(first.sessionId, first.seq)).toBe("s-1:3")
  })

  it("expired-media sessions (no segments) produce no lane, and no lanes → free-run timeline without gaps", () => {
    const empty = manifest([sess({ id: "s-x", segments: [] })], T0, T0 + 60_000)
    const emptyLanes = buildLanes(empty)
    expect(emptyLanes).toHaveLength(0)
    const tl = buildClockTimeline(emptyLanes, empty.from, empty.to)
    expect(tl.segments).toEqual([])
    expect(tl.gaps).toEqual([]) // nothing skippable — telemetry-only replay
  })
})

describe("buildLanes — one streamKey, restarted sessions (one lane)", () => {
  const a = sess({
    id: "s-a",
    segments: [seg({ seq: 0, startTs: T0 }), seg({ seq: 1, startTs: T0 + 60_000 })],
  })
  const b = sess({
    id: "s-b",
    // Restart 5 min after a ends.
    segments: [seg({ seq: 0, startTs: T0 + 420_000 })],
  })
  const m = manifest([b, a], T0, T0 + 480_000)
  const lanes = buildLanes(m)

  it("merges same-streamKey sessions into one lane, segments time-ordered", () => {
    expect(lanes).toHaveLength(1)
    expect(lanes[0].sessions.map((s) => s.id)).toEqual(["s-a", "s-b"])
    expect(
      lanes[0].timeline.segments.map((x) => (x as LaneSegment).sessionId)
    ).toEqual(["s-a", "s-a", "s-b"])
  })

  it("the inter-session hole becomes a missing-segments gap", () => {
    expect(lanes[0].timeline.gaps).toEqual([
      { fromTs: T0 + 120_000, toTs: T0 + 420_000, reason: "missing-segments" },
    ])
  })
})

describe("buildClockTimeline — two lanes", () => {
  // cam0: [T0, T0+120s) then a hole, then [T0+300s, T0+360s).
  // cam1: [T0+60s, T0+240s) — covers part of cam0's hole; both are dark in
  // [T0+240s, T0+300s).
  const cam0 = sess({
    id: "s-c0",
    segments: [
      seg({ seq: 0, startTs: T0 }),
      seg({ seq: 1, startTs: T0 + 60_000 }),
      seg({ seq: 5, startTs: T0 + 300_000 }),
    ],
    gaps: [
      { fromTs: T0 + 120_000, toTs: T0 + 300_000, reason: "missing-segments" },
    ],
  })
  const cam1 = sess({
    id: "s-c1",
    streamKey: "cam1",
    segments: [
      seg({ seq: 0, startTs: T0 + 60_000 }),
      seg({ seq: 1, startTs: T0 + 120_000 }),
      seg({ seq: 2, startTs: T0 + 180_000, finalized: false, effectiveDurationMs: 58_000 }),
    ],
  })
  const m = manifest([cam1, cam0], T0, T0 + 360_000)
  const lanes = buildLanes(m)
  const clockTl = buildClockTimeline(lanes, m.from, m.to)

  it("lanes sort by streamKey (deterministic pacer election order)", () => {
    expect(lanes.map((l) => l.streamKey)).toEqual(["cam0", "cam1"])
  })

  it("a clock gap exists only where NO lane has video", () => {
    // cam0's 180 s hole is partially covered by cam1: only the simultaneous
    // dark stretch [cam1 partial end, T0+300s) is a clock gap.
    expect(clockTl.gaps).toEqual([
      { fromTs: T0 + 238_000, toTs: T0 + 300_000, reason: "missing-segments" },
    ])
    expect(hasCoverageAt(clockTl, T0 + 200_000)).toBe(true) // cam1 only
    expect(hasCoverageAt(clockTl, T0 + 250_000)).toBe(false)
  })

  it("per-lane gap independence: each lane keeps its own holes", () => {
    expect(lanes[0].timeline.gaps).toEqual([
      { fromTs: T0 + 120_000, toTs: T0 + 300_000, reason: "missing-segments" },
    ])
    // cam1 has no video before T0+60s and after its crash cut.
    expect(lanes[1].timeline.gaps).toEqual([
      { fromTs: T0, toTs: T0 + 60_000, reason: "missing-segments" },
      { fromTs: T0 + 238_000, toTs: T0 + 360_000, reason: "missing-segments" },
    ])
  })

  it("boundaries keep every lane's real segment starts", () => {
    expect(clockTl.boundaries).toEqual([
      T0,
      T0 + 60_000,
      T0 + 120_000,
      T0 + 180_000,
      T0 + 300_000,
    ])
  })

  it("partial ticks survive the merge", () => {
    expect(clockTl.partialEnds).toEqual([T0 + 238_000])
  })

  it("synthetic coverage segments are non-overlapping (binary-search safe)", () => {
    for (let i = 1; i < clockTl.segments.length; i++) {
      const prev = clockTl.segments[i - 1]
      expect(clockTl.segments[i].startTs).toBeGreaterThanOrEqual(
        prev.startTs + prev.effectiveDurationMs
      )
    }
  })
})

describe("buildClockTimeline — range-mode dead air", () => {
  it("emits leading/trailing gaps for uncovered window edges", () => {
    const s = sess({ id: "s-1", segments: [seg({ seq: 0, startTs: T0 + 120_000 })] })
    // Window starts 2 min before video and ends 4 min after it. Two lanes
    // force the merged path; make the second a copy on another streamKey with
    // identical coverage.
    const s2 = sess({
      id: "s-2",
      streamKey: "cam1",
      segments: [seg({ seq: 0, startTs: T0 + 120_000 })],
    })
    const m = manifest([s, s2], T0, T0 + 420_000)
    const tl = buildClockTimeline(buildLanes(m), m.from, m.to)
    expect(tl.gaps).toEqual([
      { fromTs: T0, toTs: T0 + 120_000, reason: "missing-segments" },
      { fromTs: T0 + 180_000, toTs: T0 + 420_000, reason: "missing-segments" },
    ])
  })

  it("does not emit sub-2 s seams as gaps", () => {
    const a = sess({
      id: "s-a",
      segments: [
        seg({ seq: 0, startTs: T0, effectiveDurationMs: 59_000 }),
        // 1.5 s seam hole.
        seg({ seq: 1, startTs: T0 + 60_500 }),
      ],
    })
    const b = sess({
      id: "s-b",
      streamKey: "cam1",
      segments: [
        seg({ seq: 0, startTs: T0, effectiveDurationMs: 59_000 }),
        seg({ seq: 1, startTs: T0 + 60_500 }),
      ],
    })
    const m = manifest([a, b], T0, T0 + 120_500)
    const tl = buildClockTimeline(buildLanes(m), m.from, m.to)
    expect(tl.gaps).toEqual([])
    // The seam is still uncovered (free-run/micro-jump territory).
    expect(hasCoverageAt(tl, T0 + 59_500)).toBe(false)
  })
})
