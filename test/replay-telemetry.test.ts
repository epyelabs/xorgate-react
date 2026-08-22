import { describe, expect, it } from "vitest"
import type { TelemetryReading } from "@xorgate/sdk"
import {
  buildTrace,
  chooseIntervalSeconds,
  floorIndex,
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
  WINDOW_SPAN_MS,
  type GpsTrace,
  type MetricSeries,
} from "../src/replay/replay-telemetry.js"

const T0 = 1_753_286_760_000 // arbitrary epoch-ms anchor

function row(
  tsMs: number,
  metric: string,
  value: number | null,
  unit: string | null = null
): TelemetryReading {
  return { ts: new Date(tsMs).toISOString(), metric: metric as TelemetryReading["metric"], value, unit }
}

function series(ts: number[], v?: number[]): MetricSeries {
  return { ts, v: v ?? ts.map((_, i) => i), unit: null, bucketMs: null }
}

describe("seriesFromReadings", () => {
  it("pivots rows into per-metric ascending series with first non-null unit", () => {
    const s = seriesFromReadings(
      [
        row(T0, "imu.accel_x", 1, "m/s^2"),
        row(T0, "gps.lat", 45.5),
        row(T0 + 200, "imu.accel_x", 2, "m/s^2"),
        row(T0 + 1000, "gps.lat", 45.6),
      ],
      null
    )
    expect([...s.keys()].sort()).toEqual(["gps.lat", "imu.accel_x"])
    expect(s.get("imu.accel_x")).toMatchObject({
      ts: [T0, T0 + 200],
      v: [1, 2],
      unit: "m/s^2",
      bucketMs: null,
    })
  })

  it("drops null values and records bucketMs for overview responses", () => {
    const s = seriesFromReadings(
      [row(T0, "gps.lat", null), row(T0 + 2000, "gps.lat", 45.5)],
      2
    )
    expect(s.get("gps.lat")).toMatchObject({ ts: [T0 + 2000], bucketMs: 2000 })
  })

  it("sorts defensively if rows arrive out of order", () => {
    const s = seriesFromReadings(
      [row(T0 + 1000, "gps.lat", 2), row(T0, "gps.lat", 1)],
      null
    )
    expect(s.get("gps.lat")).toMatchObject({ ts: [T0, T0 + 1000], v: [1, 2] })
  })
})

describe("floorIndex", () => {
  const ts = [10, 20, 30, 40]
  it("finds the rightmost index ≤ target", () => {
    expect(floorIndex(ts, 5)).toBe(-1)
    expect(floorIndex(ts, 10)).toBe(0)
    expect(floorIndex(ts, 25)).toBe(1)
    expect(floorIndex(ts, 40)).toBe(3)
    expect(floorIndex(ts, 99)).toBe(3)
    expect(floorIndex([], 99)).toBe(-1)
  })
})

describe("latestWithin (nearest-sample resolution)", () => {
  const s: MetricSeries = {
    ts: [T0, T0 + 200, T0 + 400],
    v: [1, 2, 3],
    unit: "m/s^2",
    bucketMs: null,
  }
  // The extraction changed the return shape to the SDK's interop
  // `LatestReading` (adds `metric`, ISO `ts`); the resolution rules are
  // asserted unchanged.
  it("returns the floor sample while fresh", () => {
    expect(latestWithin("imu.accel_x", s, T0 + 450, 2500)).toEqual({
      metric: "imu.accel_x",
      value: 3,
      unit: "m/s^2",
      ts: new Date(T0 + 400).toISOString(),
    })
    // Never reads the future: a sample 50 ms ahead does not count.
    expect(latestWithin("imu.accel_x", s, T0 + 199, 2500)?.value).toBe(1)
  })
  it("returns null before the first sample and past the cutoff", () => {
    expect(latestWithin("imu.accel_x", s, T0 - 1, 2500)).toBeNull()
    expect(latestWithin("imu.accel_x", s, T0 + 400 + 2501, 2500)).toBeNull()
    // Exactly at the cutoff is still fresh.
    expect(latestWithin("imu.accel_x", s, T0 + 400 + 2500, 2500)?.value).toBe(3)
  })
})

describe("staleness cutoffs", () => {
  it("maps metric → group cutoff with a default for unknown groups", () => {
    expect(metricGroup("imu.accel_x")).toBe("imu")
    expect(stalenessMs("imu.accel_x")).toBe(2500)
    expect(stalenessMs("gps.lat")).toBe(5000)
    expect(stalenessMs("lte.rssi")).toBe(60000)
    expect(stalenessMs("mystery.field")).toBe(30000)
  })
  it("widens for coarse overview buckets but not fine ones", () => {
    expect(overviewStalenessMs("imu.accel_x", 1000)).toBe(2500)
    expect(overviewStalenessMs("imu.accel_x", 5000)).toBe(12500)
    expect(overviewStalenessMs("lte.rssi", 5000)).toBe(60000)
  })
})

describe("chooseIntervalSeconds", () => {
  it("picks the finest ladder step fitting the target buckets", () => {
    // 30 min span, 8 GPS metrics, fine target: 10000/8 = 1250 buckets max →
    // 1 s gives 1820 buckets (too many), 2 s gives 910.
    expect(chooseIntervalSeconds(1_820_000, 8, 2000)).toBe(2)
    // Coarser scrub-preview target for 10 IMU metrics: 500-bucket target →
    // 5 s gives 364 buckets.
    expect(chooseIntervalSeconds(1_820_000, 10, 500)).toBe(5)
  })
  it("respects the server row cap over the caller target", () => {
    // 1 h, 20 metrics → max 500 buckets → 3600/500 = 7.2 → 10 s.
    expect(chooseIntervalSeconds(3_600_000, 20, 5000)).toBe(10)
  })
  it("falls back to the coarsest step for absurd spans", () => {
    expect(chooseIntervalSeconds(31 * 86_400_000, 20, 1)).toBe(86400)
  })
})

describe("window hysteresis", () => {
  const FROM = T0
  const TO = T0 + 1_820_000 // 30 min replay

  it("centers on the playhead and slides (not shrinks) at the edges", () => {
    const mid = windowBoundsFor(T0 + 900_000, WINDOW_SPAN_MS, FROM, TO)
    expect(mid).toEqual({
      fromTs: T0 + 900_000 - 60_000,
      toTs: T0 + 900_000 + 60_000,
    })
    const head = windowBoundsFor(FROM, WINDOW_SPAN_MS, FROM, TO)
    expect(head).toEqual({ fromTs: FROM, toTs: FROM + WINDOW_SPAN_MS })
    const tail = windowBoundsFor(TO, WINDOW_SPAN_MS, FROM, TO)
    expect(tail).toEqual({ fromTs: TO - WINDOW_SPAN_MS, toTs: TO })
  })

  it("covers a replay shorter than the window with a single full-span window", () => {
    const w = windowBoundsFor(T0 + 10_000, WINDOW_SPAN_MS, T0, T0 + 60_000)
    expect(w).toEqual({ fromTs: T0, toTs: T0 + 60_000 })
  })

  it("holds inside the middle half, refetches outside it", () => {
    const win = windowBoundsFor(T0 + 900_000, WINDOW_SPAN_MS, FROM, TO)
    const center = T0 + 900_000
    expect(windowNeedsRefetch(win, center, WINDOW_SPAN_MS, FROM, TO)).toBe(false)
    expect(
      windowNeedsRefetch(win, center + 29_000, WINDOW_SPAN_MS, FROM, TO)
    ).toBe(false)
    expect(
      windowNeedsRefetch(win, center + 31_000, WINDOW_SPAN_MS, FROM, TO)
    ).toBe(true)
    expect(
      windowNeedsRefetch(win, center - 31_000, WINDOW_SPAN_MS, FROM, TO)
    ).toBe(true)
    expect(windowNeedsRefetch(null, center, WINDOW_SPAN_MS, FROM, TO)).toBe(true)
  })

  it("never loops at the replay edges (clamped bounds are final)", () => {
    // Playhead at the very start: it sits outside the middle half of the
    // clamped window, but a refetch would produce identical bounds — hold.
    const head = windowBoundsFor(FROM, WINDOW_SPAN_MS, FROM, TO)
    expect(windowNeedsRefetch(head, FROM, WINDOW_SPAN_MS, FROM, TO)).toBe(false)
    const tail = windowBoundsFor(TO, WINDOW_SPAN_MS, FROM, TO)
    expect(windowNeedsRefetch(tail, TO, WINDOW_SPAN_MS, FROM, TO)).toBe(false)
  })

  it("refetches when the span shrinks (truncation adaptation)", () => {
    const win = windowBoundsFor(T0 + 900_000, WINDOW_SPAN_MS, FROM, TO)
    expect(
      windowNeedsRefetch(win, T0 + 931_000, WINDOW_SPAN_MS / 2, FROM, TO)
    ).toBe(true)
  })
})

describe("GPS trace", () => {
  // 1 Hz fixes with a 240 s hole after the 3rd fix (the real fodder shape).
  const lat = series(
    [T0, T0 + 1000, T0 + 2000, T0 + 242_000, T0 + 243_000],
    [45.0, 45.1, 45.2, 45.3, 45.4]
  )
  const lon = series(
    [T0, T0 + 1000, T0 + 2000, T0 + 242_000, T0 + 243_000],
    [-73.0, -73.1, -73.2, -73.3, -73.4]
  )

  it("zips matching timestamps and breaks at recording holes", () => {
    const trace = buildTrace(lat, lon, 10_000)
    expect(trace.pts).toHaveLength(5)
    expect(trace.breaks).toEqual([3])
    expect(trace.pts[0]).toEqual([-73.0, 45.0])
  })

  it("drops unmatched samples (one coordinate missing)", () => {
    const shortLon = series([T0, T0 + 2000], [-73.0, -73.2])
    const trace = buildTrace(lat, shortLon, 10_000)
    expect(trace.ts).toEqual([T0, T0 + 2000])
  })

  it("returns an empty trace when either coordinate is absent entirely", () => {
    expect(buildTrace(lat, undefined, 10_000).pts).toHaveLength(0)
  })

  it("splits the full route into polylines at breaks", () => {
    const trace = buildTrace(lat, lon, 10_000)
    const lines = traceLines(trace)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toHaveLength(3)
    expect(lines[1]).toHaveLength(2)
  })

  it("clips the traveled portion at the playhead and appends the marker", () => {
    const trace = buildTrace(lat, lon, 10_000)
    const marker: [number, number] = [-73.15, 45.15]
    const lines = traveledLines(trace, T0 + 1500, marker)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toEqual([
      [-73.0, 45.0],
      [-73.1, 45.1],
      marker,
    ])
    // Before the first fix: nothing traveled.
    expect(traveledLines(trace, T0 - 1, marker)).toHaveLength(0)
    // Inside the hole with no marker: the pre-hole line only, no marker tail.
    expect(traveledLines(trace, T0 + 100_000, null)).toEqual([
      [
        [-73.0, 45.0],
        [-73.1, 45.1],
        [-73.2, 45.2],
      ],
    ])
  })

  it("does not bridge a break with the traveled highlight", () => {
    const trace = buildTrace(lat, lon, 10_000)
    const lines = traveledLines(trace, T0 + 243_000, null)
    expect(lines).toHaveLength(2)
    expect(lines[1]).toEqual([
      [-73.3, 45.3],
      [-73.4, 45.4],
    ])
  })
})

describe("positionAt (marker interpolation)", () => {
  const trace: GpsTrace = {
    pts: [
      [-73.0, 45.0],
      [-73.2, 45.2],
      [-73.4, 45.4],
    ],
    ts: [T0, T0 + 1000, T0 + 242_000],
    breaks: [2],
  }

  it("interpolates between close bracketing fixes", () => {
    const r = positionAt(trace, T0 + 500, 3000, 5000)
    expect(r?.interpolated).toBe(true)
    expect(r?.pos[0]).toBeCloseTo(-73.1)
    expect(r?.pos[1]).toBeCloseTo(45.1)
  })

  it("holds the last fix (no interpolation) across wide gaps while fresh", () => {
    const r = positionAt(trace, T0 + 3000, 3000, 5000)
    expect(r).toEqual({ pos: [-73.2, 45.2], interpolated: false })
  })

  it("never interpolates across a trace break", () => {
    // Floor fix is index 1; index 2 starts a new line 241 s later.
    const r = positionAt(trace, T0 + 2000, 300_000, 300_000)
    expect(r?.interpolated).toBe(false)
  })

  it("hides the marker in a stale hole and before the first fix", () => {
    expect(positionAt(trace, T0 + 100_000, 3000, 5000)).toBeNull()
    expect(positionAt(trace, T0 - 1, 3000, 5000)).toBeNull()
  })
})
