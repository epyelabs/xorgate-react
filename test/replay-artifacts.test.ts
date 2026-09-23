import { describe, expect, it } from "vitest"
import { gunzipSync, readFileSync as readFile } from "./helpers/fixtures.js"
import { XorgateError } from "@xorgate/sdk"
import type { MetricName, TelemetryInsights } from "@xorgate/sdk"
import {
  artifactKey,
  buildOverviewSeries,
  buildTrace,
  chooseBucketMs,
  insightsFromOverview,
  latestWithin,
  mergeSeries,
  overviewStalenessMs,
  overviewToSeries,
  segmentToSeries,
  segmentsCovering,
  seriesFromReadings,
  OVERVIEW_DEFAULT_TARGET_BUCKETS,
  OVERVIEW_GPS_TARGET_BUCKETS,
  type MetricSeries,
  type OverviewV1,
} from "../src/replay/replay-telemetry.js"

// Real objects from the dev bucket (test/fixtures/telemetry-artifacts/README.md).
const golden = JSON.parse(gunzipSync(readFile("overview.v1.golden.json.gz")).toString("utf8")) as OverviewV1
const small = JSON.parse(gunzipSync(readFile("overview.v1.small.json.gz")).toString("utf8")) as OverviewV1
const seg0Gz = readFile("1786314223040-00000.jsonl.gz")
const seg0 = gunzipSync(seg0Gz).toString("utf8")
const seg1 = gunzipSync(readFile("1786317672922-00001.jsonl.gz")).toString("utf8")
const seg2 = gunzipSync(readFile("1786317732965-00002.jsonl.gz")).toString("utf8")

describe("artifactKey", () => {
  it("is the S3 key: no host, no presigned query string", () => {
    const url =
      "https://xorgate-core-dev-111910761410-us-east-1.s3.us-east-1.amazonaws.com/telemetry/v1/dev/sess/overview.v1.json.gz?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc"
    expect(artifactKey(url)).toBe("telemetry/v1/dev/sess/overview.v1.json.gz")
    // A refresh changes only the signature.
    expect(artifactKey(url.replace("abc", "def"))).toBe(artifactKey(url))
    expect(artifactKey("telemetry/v1/x/y/z.jsonl.gz")).toBe("telemetry/v1/x/y/z.jsonl.gz")
  })
})

describe("overviewToSeries (real overview.v1 objects)", () => {
  it("yields one series per metric with the group's bucketMs and unit, nulls dropped", () => {
    const s = overviewToSeries(golden)
    // Four groups, every metric the segments contained (no 20-metric cap).
    expect(s.size).toBe(13 + 10 + 5 + 7)
    const lat = s.get("gps.lat")!
    expect(lat.bucketMs).toBe(5000)
    // The device emits lat/lon without a unit; speed carries one.
    expect(lat.unit).toBeNull()
    expect(s.get("gps.speed")!.unit).toBe("km/h")
    // The group grid has 633 buckets; lat is present in the ones with a fix.
    expect(golden.groups.gps.ts.length).toBe(633)
    const latNonNull = golden.groups.gps.values["gps.lat"].filter((v) => v !== null).length
    expect(lat.ts.length).toBe(latNonNull)
    expect(lat.ts.length).toBe(lat.v.length)
    // Ascending and bucket-aligned.
    for (let i = 1; i < lat.ts.length; i++) expect(lat.ts[i]).toBeGreaterThan(lat.ts[i - 1])
    expect(lat.ts.every((t) => t % 5000 === 0)).toBe(true)
    expect(s.get("imu.accel_x")!.bucketMs).toBe(15000)
    expect(s.get("lte.rssi")!.bucketMs).toBe(1000)
    // A column with nulls is shorter than its group's ts (only buckets that carried it).
    const course = s.get("gps.course")
    const nulls = golden.groups.gps.values["gps.course"].filter((v) => v === null).length
    expect(course!.ts.length).toBe(633 - nulls)
  })

  it("is the same MetricSeries shape seriesFromReadings makes, so the derivations are untouched", () => {
    const fromArtifact = overviewToSeries(small).get("gps.lat")!
    const rows = fromArtifact.ts.map((t, i) => ({
      ts: new Date(t).toISOString(),
      metric: "gps.lat" as MetricName,
      value: fromArtifact.v[i],
      unit: fromArtifact.unit,
    }))
    const fromRest = seriesFromReadings(rows, 1).get("gps.lat")!
    expect(fromArtifact).toEqual(fromRest)
    // and the route builds from it
    const trace = buildTrace(overviewToSeries(golden).get("gps.lat"), overviewToSeries(golden).get("gps.lon"), 30_000)
    expect(trace.pts.length).toBe(overviewToSeries(golden).get("gps.lat")!.ts.length)
    expect(trace.pts.length).toBeGreaterThan(600)
    const [minLon, minLat, maxLon, maxLat] = golden.groups.gps.bbox!
    for (const [lon, lat] of trace.pts) {
      expect(lon).toBeGreaterThanOrEqual(minLon)
      expect(lon).toBeLessThanOrEqual(maxLon)
      expect(lat).toBeGreaterThanOrEqual(minLat)
      expect(lat).toBeLessThanOrEqual(maxLat)
    }
  })

  it("a native-period overview resolves at the playhead with the group's own staleness", () => {
    const s = overviewToSeries(small)
    const temp = s.get("system.cpu_temp")!
    expect(temp.bucketMs).toBe(1000)
    const r = latestWithin("system.cpu_temp", temp, temp.ts[5] + 400, overviewStalenessMs("system.cpu_temp", 1000))
    expect(r).toMatchObject({ metric: "system.cpu_temp", value: temp.v[5], unit: "°C" })
  })

  it("tolerates a group without values and an object without groups", () => {
    expect(overviewToSeries({ ...golden, groups: {} }).size).toBe(0)
    expect(overviewToSeries({ ...golden, groups: { gps: { bucketMs: 1000, ts: [1], units: {}, values: {} } } }).size).toBe(0)
  })
})

describe("insightsFromOverview", () => {
  it("passes the insights block through, null when absent", () => {
    const i = insightsFromOverview(golden) as TelemetryInsights
    expect(i.computed.distance).toBe(1)
    expect(i.distance?.meters).toBe(25181.6)
    expect(i.events.filter((e) => e.kind === "stop").length).toBe(3)
    expect(insightsFromOverview({ ...golden, insights: null })).toBeNull()
  })
})

describe("segmentToSeries (real raw segments)", () => {
  it("decodes JSONL into raw per-metric series, header separate, bounds from the samples", () => {
    const d = segmentToSeries(seg0, "seg0")
    expect(d.header).toMatchObject({ v: 1, sessionId: "019fe89f-e9a8-7882-bfb0-aee70ea2b8df", timeSource: "rtc", rateHz: 1 })
    expect(d.samples).toBe(60)
    expect(d.invalidLines).toBe(0)
    // seq 0 spans 57 minutes for 60 samples: a recording hole inside one file.
    expect(d.fromTs).toBe(1786314223040)
    expect(d.toTs).toBe(1786317671923)
    const temp = d.series.get("system.cpu_temp")!
    expect(temp.bucketMs).toBeNull()
    expect(temp.unit).toBe("°C")
    // Not every sample carries every group (the recorder gates on freshness).
    expect(temp.ts.length).toBeGreaterThan(0)
    expect(temp.ts.length).toBeLessThanOrEqual(60)
    const longest = Math.max(...[...d.series.values()].map((s) => s.ts.length))
    expect(longest).toBeGreaterThanOrEqual(50)
    expect(longest).toBeLessThanOrEqual(60)
    // metrics are group.field from the nested object; only numeric leaves
    expect([...d.series.keys()].every((m) => m.includes("."))).toBe(true)
    expect(d.series.has("system.throttled")).toBe(true)
  })

  it("keeps going past a malformed line and counts it", () => {
    const d = segmentToSeries(seg1.replace("\n", "\nnot json\n"), "seg1")
    expect(d.invalidLines).toBe(1)
    expect(d.samples).toBe(60)
  })

  it("throws a typed INVALID_RESPONSE naming the key when the body is still gzip", () => {
    // What a browser sees if an object were served WITHOUT Content-Encoding.
    const stillCompressed = seg0Gz.toString("latin1")
    expect(stillCompressed.charCodeAt(0)).toBe(0x1f)
    let caught: unknown
    try {
      segmentToSeries(stillCompressed, "telemetry/v1/dev/sess/1786314223040-00000.jsonl.gz")
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(XorgateError)
    expect((caught as XorgateError).code).toBe("INVALID_RESPONSE")
    expect((caught as XorgateError).message).toContain("1786314223040-00000.jsonl.gz")
  })
})

describe("mergeSeries", () => {
  it("concatenates parts in order, keeps the first unit and the widest bucket", () => {
    const a = segmentToSeries(seg0).series
    const b = segmentToSeries(seg1).series
    const c = segmentToSeries(seg2).series
    const m = mergeSeries([a, b, c])
    const lat = m.get("gps.lat")!
    expect(lat.ts.length).toBe(a.get("gps.lat")!.ts.length + b.get("gps.lat")!.ts.length + c.get("gps.lat")!.ts.length)
    for (let i = 1; i < lat.ts.length; i++) expect(lat.ts[i]).toBeGreaterThan(lat.ts[i - 1])
    const wide: MetricSeries = { ts: [1], v: [1], unit: null, bucketMs: 15000 }
    const raw: MetricSeries = { ts: [2], v: [2], unit: "x", bucketMs: null }
    const merged = mergeSeries([new Map([["m.x" as MetricName, raw]]), new Map([["m.x" as MetricName, wide]])])
    expect(merged.get("m.x")).toMatchObject({ ts: [2, 1].sort(), bucketMs: 15000, unit: "x" })
  })

  it("sorts defensively if parts arrive out of order", () => {
    const b = segmentToSeries(seg1).series
    const a = segmentToSeries(seg0).series
    const m = mergeSeries([b, a]).get("system.cpu_temp")!
    for (let i = 1; i < m.ts.length; i++) expect(m.ts[i]).toBeGreaterThan(m.ts[i - 1])
  })
})

describe("buildOverviewSeries (client-built overview for open sessions)", () => {
  it("keeps a group raw while under its target", () => {
    const raw = mergeSeries([segmentToSeries(seg0).series, segmentToSeries(seg1).series, segmentToSeries(seg2).series])
    const built = buildOverviewSeries(raw)
    expect(built.get("gps.lat")).toBe(raw.get("gps.lat")) // same object: no averaging at all
    expect(built.get("gps.lat")!.bucketMs).toBeNull()
  })

  it("buckets a group above its target at the server's ladder rung, ts = bucket start, 6 dp", () => {
    // 3 000 one-second gps samples over 50 minutes: above 2 000 → the 2 s rung.
    const ts = Array.from({ length: 3000 }, (_, i) => 1_786_314_222_000 + i * 1000)
    const raw = new Map<MetricName, MetricSeries>([
      ["gps.lat", { ts, v: ts.map((_, i) => 43 + i * 0.0000001), unit: "deg", bucketMs: null }],
      ["gps.lon", { ts, v: ts.map(() => -79.5), unit: "deg", bucketMs: null }],
      ["imu.accel_x", { ts: ts.slice(0, 400), v: ts.slice(0, 400).map(() => 1), unit: null, bucketMs: null }],
    ])
    const built = buildOverviewSeries(raw)
    const lat = built.get("gps.lat")!
    expect(chooseBucketMs(2_999_000, OVERVIEW_GPS_TARGET_BUCKETS)).toBe(2000)
    expect(lat.bucketMs).toBe(2000)
    expect(lat.ts.length).toBe(1500)
    expect(lat.ts.every((t) => t % 2000 === 0)).toBe(true)
    expect(lat.ts).toEqual(built.get("gps.lon")!.ts) // lat and lon still pair by exact ts
    expect(String(lat.v[0]).split(".")[1]?.length ?? 0).toBeLessThanOrEqual(6)
    // A different group under ITS target stays raw.
    expect(built.get("imu.accel_x")!.bucketMs).toBeNull()
    expect(chooseBucketMs(3_600_000, OVERVIEW_DEFAULT_TARGET_BUCKETS)).toBe(10_000)
  })

  it("matches the server's overview for the same session within rounding", () => {
    // The small overview was built server-side from ONE 60-sample segment at
    // the native period; seq 0 of the golden session is the same segment
    // time-shifted, so the values line up sample for sample.
    const server = overviewToSeries(small).get("system.cpu_temp")!
    const client = buildOverviewSeries(segmentToSeries(seg0).series).get("system.cpu_temp")!
    expect(client.v).toEqual(server.v)
  })
})

describe("segmentsCovering", () => {
  const segs = [
    { seq: 0, startTs: 0, endTs: 3_400_000 }, // spans a hole
    { seq: 1, startTs: 3_500_000, endTs: 3_560_000 },
    { seq: 2, startTs: 3_560_000, endTs: 3_620_000 },
    { seq: 3, startTs: 3_620_000, endTs: 3_680_000 },
  ]
  it("selects the segments whose bounds overlap the window, in order", () => {
    expect(segmentsCovering(segs, 3_540_000, 3_600_000).map((s) => s.seq)).toEqual([1, 2])
    expect(segmentsCovering(segs, 1_000_000, 1_500_000).map((s) => s.seq)).toEqual([0])
    expect(segmentsCovering(segs, 4_000_000, 5_000_000)).toEqual([])
  })
  it("appends the first segment after the window when asked to prefetch", () => {
    expect(segmentsCovering(segs, 3_540_000, 3_600_000, true).map((s) => s.seq)).toEqual([1, 2, 3])
    expect(segmentsCovering(segs, 3_650_000, 3_700_000, true).map((s) => s.seq)).toEqual([3])
  })
})

// --- window clipping and the window summary (0.4.1) -------------------------
import { clipSeries, summarizeGpsSeries } from "../src/replay/replay-telemetry.js";

describe("clipSeries + summarizeGpsSeries", () => {
  const goldenObj = JSON.parse(gunzipSync(readFile("overview.v1.golden.json.gz")).toString("utf8")) as OverviewV1;
  const series = overviewToSeries(goldenObj);
  const gpsTs = goldenObj.groups.gps.ts;

  it("clips every series to the window and keeps an untouched one by reference", () => {
    const mid = gpsTs[Math.floor(gpsTs.length / 2)];
    const clipped = clipSeries(series, mid, goldenObj.to);
    const lat = clipped.get("gps.lat" as never)!;
    expect(lat.ts[0]).toBeGreaterThanOrEqual(mid);
    expect(lat.ts.length).toBeLessThan(series.get("gps.lat" as never)!.ts.length);
    expect(lat.ts.length).toBe(lat.v.length);
    const whole = clipSeries(series, goldenObj.from, goldenObj.to);
    expect(whole.get("gps.lat" as never)).toBe(series.get("gps.lat" as never));
    expect(clipSeries(series, goldenObj.to + 1, goldenObj.to + 2).size).toBe(0);
  });

  it("the whole session's summary agrees with the server's raw-sample distance within 2 %", () => {
    const s = summarizeGpsSeries(series, goldenObj.from, goldenObj.to)!;
    const raw = goldenObj.insights!.distance!.meters as number; // 25 181.6
    expect(Math.abs(s.distanceM - raw) / raw).toBeLessThan(0.02);
    expect(s.method).toBe("overview-haversine");
    expect(s.movingMs).toBeGreaterThan(0);
  });

  it("a window counts only what lies inside it; a parked half minute is metres, not the drive", () => {
    const mid = gpsTs[Math.floor(gpsTs.length / 2)];
    const a = summarizeGpsSeries(series, goldenObj.from, mid - 1)!;
    const b = summarizeGpsSeries(series, mid, goldenObj.to)!;
    const all = summarizeGpsSeries(series, goldenObj.from, goldenObj.to)!;
    expect(a.distanceM).toBeGreaterThan(0);
    expect(b.distanceM).toBeGreaterThan(0);
    expect(Math.abs(a.distanceM + b.distanceM - all.distanceM)).toBeLessThan(200); // at most the one 5 s leg straddling `mid`
    // The drive's first fix lands 19 s after `from` (position.startAt), so the
    // parked half minute holds a handful of buckets or none: metres or null.
    const parked = summarizeGpsSeries(series, goldenObj.from, goldenObj.from + 36_000);
    expect(parked?.distanceM ?? 0).toBeLessThan(100);
    expect(summarizeGpsSeries(series, goldenObj.to + 1, goldenObj.to + 60_000)).toBeNull();
  });
});
