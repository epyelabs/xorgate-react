import { describe, expect, it } from "vitest"
import type { ReplaySegment } from "@xorgate/sdk"
import { ReplayClock } from "../src/replay/replay-clock.js"
import { buildTimeline, hasCoverageAt, type ReplayTimeline } from "../src/replay/timeline.js"

const T0 = 1_753_280_000_000

function seg(seq: number, startTs: number, durationMs = 60_000): ReplaySegment {
  return {
    seq,
    startTs,
    effectiveDurationMs: durationMs,
    finalized: true,
    anchor: "boundary",
    sizeBytes: null,
    url: `https://example.test/${seq}.mp4`,
  }
}

// Two segments, a 180 s hole, one segment: [T0, T0+120s) video, gap to
// T0+300s, then [T0+300s, T0+360s).
const tl = buildTimeline(
  {
    segments: [seg(0, T0), seg(1, T0 + 60_000), seg(4, T0 + 300_000)],
    gaps: [{ fromTs: T0 + 120_000, toTs: T0 + 300_000, reason: "missing-segments" }],
  },
  T0,
  T0 + 360_000
)

describe("free-run pacing", () => {
  it("advances at rate × real time without a pacer", () => {
    const clock = new ReplayClock(tl)
    clock.play()
    clock.tick(1000)
    expect(clock.getState().playheadTs).toBe(T0 + 1000)
    clock.setRate(4)
    clock.tick(1000)
    expect(clock.getState().playheadTs).toBe(T0 + 5000)
  })

  it("does not advance while paused", () => {
    const clock = new ReplayClock(tl)
    clock.tick(1000)
    expect(clock.getState().playheadTs).toBe(T0)
  })

  it("stops at the end of the replay span", () => {
    const clock = new ReplayClock(tl, T0 + 359_500)
    clock.play()
    clock.tick(2000)
    const st = clock.getState()
    expect(st.playheadTs).toBe(tl.to)
    expect(st.playing).toBe(false)
  })

  it("play at the end restarts from the top", () => {
    const clock = new ReplayClock(tl, tl.to)
    clock.play()
    const st = clock.getState()
    expect(st.playheadTs).toBe(tl.from)
    expect(st.playing).toBe(true)
  })
})

describe("gap handling", () => {
  it("skips a manifest gap when skipGaps is on (default)", () => {
    const clock = new ReplayClock(tl, T0 + 119_500)
    clock.play()
    const seekSeqBefore = clock.getState().seekSeq
    clock.tick(1000) // crosses into the gap at T0+120s
    const st = clock.getState()
    expect(st.playheadTs).toBe(T0 + 300_000)
    expect(st.lastSkip?.fromTs).toBe(T0 + 120_000)
    expect(st.lastSkip?.toTs).toBe(T0 + 300_000)
    // A skip is a discontinuity — the video tile must re-align.
    expect(st.seekSeq).toBe(seekSeqBefore + 1)
  })

  it("free-runs through the gap when skipGaps is off", () => {
    const clock = new ReplayClock(tl, T0 + 119_500)
    clock.setSkipGaps(false)
    clock.play()
    clock.tick(1000)
    expect(clock.getState().playheadTs).toBe(T0 + 120_500)
    expect(clock.getState().lastSkip).toBeNull()
  })

  it("a seek into a gap then skipGaps-on jumps on the next tick", () => {
    const clock = new ReplayClock(tl)
    clock.seek(T0 + 200_000)
    clock.play()
    clock.tick(16)
    expect(clock.getState().playheadTs).toBe(T0 + 300_000)
  })

  it("free-runs (not skips) across uncovered stretches with no manifest gap", () => {
    // Open-session shape: coverage simply ends before `to`.
    const openTl = buildTimeline(
      { segments: [seg(0, T0)], gaps: [] },
      T0,
      T0 + 120_000
    )
    const clock = new ReplayClock(openTl, T0 + 59_900)
    clock.play()
    clock.tick(1000)
    expect(clock.getState().playheadTs).toBe(T0 + 60_900)
  })
})

describe("seek", () => {
  it("clamps to the replay span and bumps seekSeq", () => {
    const clock = new ReplayClock(tl)
    const before = clock.getState().seekSeq
    clock.seek(tl.to + 99_999)
    expect(clock.getState().playheadTs).toBe(tl.to)
    clock.seek(tl.from - 99_999)
    expect(clock.getState().playheadTs).toBe(tl.from)
    expect(clock.getState().seekSeq).toBe(before + 2)
  })
})

// A tile's registration: reads a mutable ts, covers per its lane timeline.
function register(
  clock: ReplayClock,
  id: string,
  lane: ReplayTimeline,
  read: () => number
): () => void {
  return clock.registerPacer(id, {
    read,
    covers: (ts) => hasCoverageAt(lane, ts),
  })
}

describe("pacer handoff (video ↔ timer)", () => {
  it("uses the pacer while playing with coverage", () => {
    const clock = new ReplayClock(tl, T0 + 30_000)
    let videoTs = T0 + 30_000
    register(clock, "cam0", tl, () => videoTs)
    clock.play()
    videoTs += 987
    clock.tick(16) // dt is irrelevant while paced
    expect(clock.getState().playheadTs).toBe(T0 + 30_987)
    expect(clock.pacerId()).toBe("cam0")
  })

  it("a stalled pacer freezes the clock (video is truth under coverage)", () => {
    const clock = new ReplayClock(tl, T0 + 30_000)
    register(clock, "cam0", tl, () => T0 + 30_000)
    clock.play()
    clock.tick(5000)
    expect(clock.getState().playheadTs).toBe(T0 + 30_000)
  })

  it("falls back to free-run inside a gap even with a pacer mounted", () => {
    const clock = new ReplayClock(tl, T0 + 130_000)
    clock.setSkipGaps(false)
    register(clock, "cam0", tl, () => T0 + 120_000) // video stuck at the gap edge
    clock.play()
    clock.tick(1000)
    expect(clock.getState().playheadTs).toBe(T0 + 131_000)
    expect(clock.pacerId()).toBeNull()
  })

  it("hands back to the pacer when free-run re-enters coverage", () => {
    const clock = new ReplayClock(tl, T0 + 299_900)
    clock.setSkipGaps(false)
    let videoTs = T0 + 300_000
    register(clock, "cam0", tl, () => videoTs)
    clock.play()
    clock.tick(200) // free-run crosses the gap end into seq-4 coverage
    expect(clock.getState().playheadTs).toBe(T0 + 300_100)
    // Next tick: coverage at playhead → pacer wins.
    videoTs = T0 + 300_400
    clock.tick(16)
    expect(clock.getState().playheadTs).toBe(T0 + 300_400)
  })

  it("without a pacer (telemetry-only replay) the clock still free-runs under coverage", () => {
    const clock = new ReplayClock(tl, T0 + 10_000)
    clock.play()
    clock.tick(500)
    expect(clock.getState().playheadTs).toBe(T0 + 10_500)
  })
})

describe("pacer election (multi-lane composite)", () => {
  // Lane A covers [T0, T0+120s); lane B covers [T0+60s, T0+240s). Overlap in
  // the middle, each with an exclusive stretch on its own side.
  const laneA = buildTimeline(
    { segments: [seg(0, T0), seg(1, T0 + 60_000)], gaps: [] },
    T0,
    T0 + 240_000
  )
  const laneB = buildTimeline(
    {
      segments: [
        seg(0, T0 + 60_000),
        seg(1, T0 + 120_000),
        seg(2, T0 + 180_000),
      ],
      gaps: [],
    },
    T0,
    T0 + 240_000
  )
  const both = buildTimeline(
    {
      segments: [seg(0, T0), seg(1, T0 + 60_000), seg(2, T0 + 120_000), seg(3, T0 + 180_000)],
      gaps: [],
    },
    T0,
    T0 + 240_000
  )

  it("first registered lane with coverage wins", () => {
    const clock = new ReplayClock(both, T0 + 90_000) // both lanes cover
    let a = T0 + 90_000
    let b = T0 + 90_000
    register(clock, "cam0", laneA, () => a)
    register(clock, "cam1", laneB, () => b)
    clock.play()
    a += 100
    b += 999
    clock.tick(16)
    expect(clock.pacerId()).toBe("cam0")
    expect(clock.getState().playheadTs).toBe(T0 + 90_100)
  })

  it("elects the only covering lane when the first lacks coverage", () => {
    const clock = new ReplayClock(both, T0 + 150_000) // only lane B covers
    register(clock, "cam0", laneA, () => T0)
    let b = T0 + 150_000
    register(clock, "cam1", laneB, () => b)
    clock.play()
    b += 200
    clock.tick(16)
    expect(clock.pacerId()).toBe("cam1")
    expect(clock.getState().playheadTs).toBe(T0 + 150_200)
  })

  it("election is sticky: the incumbent keeps pacing through overlap, then hands off when its lane ends", () => {
    const clock = new ReplayClock(both, T0 + 110_000)
    let a = T0 + 110_000
    let b = T0 + 110_000
    // cam1 registered FIRST — but cam0 will be elected below and must retain
    // the role while it still covers, proving stickiness beats order.
    register(clock, "cam1", laneB, () => b)
    register(clock, "cam0", laneA, () => a)
    clock.play()
    clock.tick(16) // elects cam1 (first registered; both cover)
    expect(clock.pacerId()).toBe("cam1")
    // Drive cam1 forward past lane A's end; it stays elected while covering.
    b = T0 + 119_000
    a = T0 + 119_000
    clock.tick(16)
    expect(clock.pacerId()).toBe("cam1")
    // Past lane A's end (T0+120s): cam1 still covers, cam0 does not.
    b = T0 + 125_000
    clock.tick(16)
    expect(clock.pacerId()).toBe("cam1")
    expect(clock.getState().playheadTs).toBe(T0 + 125_000)
  })

  it("hands off when the incumbent loses coverage mid-replay", () => {
    const clock = new ReplayClock(both, T0 + 110_000)
    let a = T0 + 110_000
    let b = T0 + 110_000
    register(clock, "cam0", laneA, () => a)
    register(clock, "cam1", laneB, () => b)
    clock.play()
    clock.tick(16)
    expect(clock.pacerId()).toBe("cam0")
    // cam0's element crosses its lane end; election re-runs and cam1 takes
    // over pacing from the current playhead.
    a = T0 + 121_000
    clock.tick(16)
    expect(clock.getState().playheadTs).toBe(T0 + 121_000)
    b = T0 + 121_500
    clock.tick(16)
    expect(clock.pacerId()).toBe("cam1")
    expect(clock.getState().playheadTs).toBe(T0 + 121_500)
  })

  it("unregistering the elected pacer clears the election", () => {
    const clock = new ReplayClock(both, T0 + 90_000)
    const off = register(clock, "cam0", laneA, () => T0 + 90_000)
    register(clock, "cam1", laneB, () => T0 + 90_500)
    clock.play()
    clock.tick(16)
    expect(clock.pacerId()).toBe("cam0")
    off()
    clock.tick(16)
    expect(clock.pacerId()).toBe("cam1")
  })
})
