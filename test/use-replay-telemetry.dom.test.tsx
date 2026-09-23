// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MetricName,
  ReplayTelemetry,
  ReplayTelemetrySession,
  TelemetryHistory,
  TelemetryReading,
} from "@xorgate/sdk";
import { XorgateProvider } from "../src/context.js";
import { useReplayTelemetry } from "../src/replay/use-replay-telemetry.js";
import type { UseReplayPlayerCore } from "../src/replay/use-replay-player-core.js";
import type { ReplayTimeline } from "../src/replay/timeline.js";
import { gunzipSync, readFileSync } from "./helpers/fixtures.js";

/**
 * `useReplayTelemetry` over a fake player core and a stubbed `fetch`: mode
 * selection (manifest block present ⇒ artifacts, never REST), the cache by
 * S3 key across a presigned-URL refresh, `allSettled` degradation, one
 * expiry notice per 403 burst, an open session growing, and the REST
 * fallback's own `allSettled`.
 */

const VEND = {
  accessKeyId: "AK",
  secretAccessKey: "SK",
  sessionToken: "ST",
  expiration: new Date(Date.now() + 3600_000).toISOString(),
  organizationId: "org-1",
  workspaceId: "ws-1",
  live: { region: "us-east-1", realtimeEndpoint: "iot-ats.example.com" },
};

const DEVICE = "a73f7a36-2a9c-45c4-a66c-54d3b018a7f7";
const HOST = "https://bucket.s3.us-east-1.amazonaws.com/";

const goldenOverview = gunzipSync(readFileSync("overview.v1.golden.json.gz")).toString("utf8");
const golden = JSON.parse(goldenOverview) as { from: number; to: number };
const seg0 = gunzipSync(readFileSync("1786314223040-00000.jsonl.gz")).toString("utf8");
const seg1 = gunzipSync(readFileSync("1786317672922-00001.jsonl.gz")).toString("utf8");
const seg2 = gunzipSync(readFileSync("1786317732965-00002.jsonl.gz")).toString("utf8");

const OVERVIEW_KEY = "telemetry/v1/dev/019fe89f/overview.v1.json.gz";
const SEG_KEYS = [
  "telemetry/v1/dev/019fe89f/1786314223040-00000.jsonl.gz",
  "telemetry/v1/dev/019fe89f/1786317672922-00001.jsonl.gz",
  "telemetry/v1/dev/019fe89f/1786317732965-00002.jsonl.gz",
];
const SEG_BODIES: Record<string, string> = {
  [SEG_KEYS[0]]: seg0,
  [SEG_KEYS[1]]: seg1,
  [SEG_KEYS[2]]: seg2,
};
const SEG_BOUNDS = [
  { startTs: 1786314223040, endTs: 1786317671923 },
  { startTs: 1786317672922, endTs: 1786317731968 },
  { startTs: 1786317732965, endTs: 1786317792922 },
];

function url(key: string, sig = "sig1"): string {
  return `${HOST}${key}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=${sig}`;
}

function session(
  overrides: Partial<ReplayTelemetrySession> & { sig?: string; segmentCount?: number } = {},
): ReplayTelemetrySession {
  const { sig = "sig1", segmentCount = 3, ...rest } = overrides;
  return {
    id: "019fe89f-e9a8-7882-bfb0-aee70ea2b8df",
    status: "closed",
    rateHz: 1,
    timeSource: "rtc",
    from: golden.from,
    to: golden.to,
    overview: { format: "overview.v1", url: url(OVERVIEW_KEY, sig), bytes: 23579, builtAt: 1 },
    segments: SEG_KEYS.slice(0, segmentCount).map((key, i) => ({
      seq: i,
      ...SEG_BOUNDS[i],
      samples: 60,
      bytes: 4000,
      url: url(key, sig),
    })),
    insights: null,
    ...rest,
  };
}

function timelineOf(from: number, to: number): ReplayTimeline {
  return { from, to, segments: [], gaps: [], boundaries: [], partialEnds: [] };
}

interface FakePlayer {
  core: UseReplayPlayerCore;
  notifyUrlsExpired: ReturnType<typeof vi.fn>;
}

function player(
  telemetry: ReplayTelemetry | null,
  timeline: ReplayTimeline | null,
  playheadTs = timeline?.from ?? 0,
): FakePlayer {
  const notifyUrlsExpired = vi.fn();
  const core = {
    clock: null,
    timeline,
    lanes: [],
    telemetry,
    playheadTs,
    playing: false,
    rate: 1,
    skipGaps: true,
    lastSkip: null,
    play: () => undefined,
    pause: () => undefined,
    toggle: () => undefined,
    seek: () => undefined,
    setRate: () => undefined,
    setSkipGaps: () => undefined,
    stepBoundary: () => undefined,
    attachLane: () => () => undefined,
    laneState: () => ({ streamKey: "cam0", status: "loading", inGap: false, isPacer: false, error: null }),
    notifyUrlsExpired,
  } as unknown as UseReplayPlayerCore;
  return { core, notifyUrlsExpired };
}

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(XorgateProvider, {
    auth: { getLiveCredentials: async () => VEND },
    organizationId: "org-1",
    config: {},
    children,
  });

/** A `fetch` stub serving the fixtures by S3 key, with per-key overrides. */
function stubFetch(overrides: Record<string, () => Response> = {}) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(u);
    const key = u.slice(HOST.length, u.indexOf("?"));
    if (overrides[key]) return overrides[key]();
    if (key === OVERVIEW_KEY) {
      return new Response(goldenOverview, { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (SEG_BODIES[key]) {
      return new Response(SEG_BODIES[key], { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
    }
    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, keys: () => calls.map((u) => u.slice(HOST.length, u.indexOf("?"))) };
}

const reported: unknown[] = [];
beforeEach(() => {
  reported.length = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useReplayTelemetry: mode selection", () => {
  it("manifest block present ⇒ artifact mode: the overview is one S3 GET and REST is never called", async () => {
    const f = stubFetch();
    const fetchTelemetry = vi.fn<(id: string, p: unknown) => Promise<TelemetryHistory>>();
    const p = player({ sessions: [session()], truncated: false }, timelineOf(golden.from, golden.to));
    const { result } = renderHook(
      () => useReplayTelemetry(DEVICE, p.core, { fetchTelemetry: fetchTelemetry as never }),
      { wrapper },
    );
    expect(result.current.source).toBe("artifacts");
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.hasGps).toBe(true);
    expect(result.current.routeLines.reduce((n, l) => n + l.length, 0)).toBeGreaterThan(600);
    // every metric the artifacts contain is resolvable, no device/model round trip
    expect(Object.keys(result.current.latest).length).toBeGreaterThan(0);
    expect(fetchTelemetry).not.toHaveBeenCalled();
    // one overview GET; the window at the replay start fetched seq 0 (and prefetched seq 1)
    expect(f.keys().filter((k) => k === OVERVIEW_KEY)).toHaveLength(1);
    await waitFor(() => expect(f.keys()).toContain(SEG_KEYS[0]));
  });

  it("an empty block is the honest empty state, not a REST fallback", async () => {
    stubFetch();
    const fetchTelemetry = vi.fn<(id: string, p: unknown) => Promise<TelemetryHistory>>();
    const p = player({ sessions: [], truncated: false }, timelineOf(1000, 2000));
    const { result } = renderHook(
      () => useReplayTelemetry(DEVICE, p.core, { fetchTelemetry: fetchTelemetry as never }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.source).toBe("artifacts");
    expect(result.current.hasGps).toBe(false);
    expect(result.current.error).toBeNull();
    expect(fetchTelemetry).not.toHaveBeenCalled();
  });

  it("no block ⇒ REST via the override; null before a replay exists", async () => {
    const f = stubFetch();
    const fetchTelemetry = vi.fn(async (): Promise<TelemetryHistory> => ({
      readings: [],
      bucketSeconds: null,
      truncated: false,
    }));
    const none = player(null, null);
    const { result: idle } = renderHook(() => useReplayTelemetry(DEVICE, none.core), { wrapper });
    expect(idle.current.source).toBeNull();

    const p = player(null, timelineOf(1000, 200_000));
    const { result } = renderHook(
      () =>
        useReplayTelemetry(DEVICE, p.core, {
          metrics: ["gps.lat", "gps.lon"] as MetricName[],
          fetchTelemetry,
        }),
      { wrapper },
    );
    expect(result.current.source).toBe("rest");
    await waitFor(() => expect(fetchTelemetry).toHaveBeenCalled());
    expect(f.calls).toHaveLength(0);
  });
});

describe("useReplayTelemetry: artifact cache and refresh", () => {
  it("caches by S3 key: a presigned-URL refresh and a seek back refetch nothing", async () => {
    const f = stubFetch();
    const tl = timelineOf(golden.from, golden.to);
    const initial = { sessions: [session({ sig: "sig1" })], truncated: false };
    const props = { p: player(initial, tl, tl.from) };
    const { result, rerender } = renderHook(({ p }: { p: FakePlayer }) => useReplayTelemetry(DEVICE, p.core), {
      wrapper,
      initialProps: props,
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => expect(f.keys()).toContain(SEG_KEYS[0]));
    const before = f.calls.length;

    // The manifest refreshes with new signatures on the same objects.
    rerender({ p: player({ sessions: [session({ sig: "sig2" })], truncated: false }, tl, tl.from) });
    await new Promise((r) => setTimeout(r, 30));
    expect(f.calls.length).toBe(before);

    // Seek into seq 2's stretch, then back to the start.
    rerender({ p: player({ sessions: [session({ sig: "sig2" })], truncated: false }, tl, SEG_BOUNDS[2].startTs + 5000) });
    await waitFor(() => expect(f.keys()).toContain(SEG_KEYS[2]));
    const afterSeek = f.calls.length;
    rerender({ p: player({ sessions: [session({ sig: "sig2" })], truncated: false }, tl, tl.from) });
    await new Promise((r) => setTimeout(r, 30));
    expect(f.calls.length).toBe(afterSeek);
    // Every artifact was fetched at most once.
    const counts = new Map<string, number>();
    for (const k of f.keys()) counts.set(k, (counts.get(k) ?? 0) + 1);
    for (const [, n] of counts) expect(n).toBe(1);
  });

  it("builds the overview from raw segments while `overview` is null, and extends it when the block grows", async () => {
    const f = stubFetch();
    const tl = timelineOf(SEG_BOUNDS[0].startTs, SEG_BOUNDS[2].endTs);
    const open = (n: number): ReplayTelemetry => ({
      sessions: [session({ status: "open", overview: null, segmentCount: n })],
      truncated: false,
    });
    const { result, rerender } = renderHook(({ p }: { p: FakePlayer }) => useReplayTelemetry(DEVICE, p.core), {
      wrapper,
      initialProps: { p: player(open(2), tl) },
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.source).toBe("artifacts");
    expect(f.keys()).not.toContain(OVERVIEW_KEY);
    const pts2 = result.current.routeLines.reduce((n, l) => n + l.length, 0);
    expect(pts2).toBeGreaterThan(0);
    const fetchedBefore = f.keys().filter((k) => k === SEG_KEYS[0] || k === SEG_KEYS[1]).length;

    // The 60 s poll lists a third segment.
    rerender({ p: player(open(3), tl) });
    await waitFor(() => expect(result.current.routeLines.reduce((n, l) => n + l.length, 0)).toBeGreaterThan(pts2));
    // Only the new key was fetched.
    expect(f.keys().filter((k) => k === SEG_KEYS[0] || k === SEG_KEYS[1]).length).toBe(fetchedBefore);
    expect(f.keys().filter((k) => k === SEG_KEYS[2]).length).toBe(1);
  });

  it("allSettled: a failed session degrades that session, the replay keeps the rest", async () => {
    stubFetch({
      "telemetry/v1/dev/other/overview.v1.json.gz": () => new Response("boom", { status: 500 }),
    });
    const bad = session({
      id: "019fe904-456d-7f96-8b84-54d0a712b344",
      from: golden.to + 1,
      to: golden.to + 100_000,
      overview: { format: "overview.v1", url: url("telemetry/v1/dev/other/overview.v1.json.gz"), bytes: 1, builtAt: 1 },
      segments: [],
    });
    const p = player({ sessions: [session(), bad], truncated: false }, timelineOf(golden.from, golden.to + 100_000));
    const { result } = renderHook(() => useReplayTelemetry(DEVICE, p.core), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.hasGps).toBe(true);
  });

  it("error only when every session failed", async () => {
    stubFetch({ [OVERVIEW_KEY]: () => new Response("boom", { status: 500 }) });
    const p = player({ sessions: [session()], truncated: false }, timelineOf(golden.from, golden.to));
    const { result } = renderHook(() => useReplayTelemetry(DEVICE, p.core), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error?.code).toBe("SERVER_ERROR");
    expect(result.current.hasGps).toBe(false);
  });

  it("403 ⇒ the player's expiry seam once per burst, and the refreshed manifest retries", async () => {
    let forbidden = true;
    const f = stubFetch({
      [OVERVIEW_KEY]: () =>
        forbidden
          ? new Response("expired", { status: 403 })
          : new Response(goldenOverview, { status: 200, headers: { "Content-Type": "application/json" } }),
      [SEG_KEYS[0]]: () =>
        forbidden
          ? new Response("expired", { status: 403 })
          : new Response(seg0, { status: 200, headers: { "Content-Type": "application/x-ndjson" } }),
    });
    const tl = timelineOf(golden.from, golden.to);
    const p1 = player({ sessions: [session({ sig: "old" })], truncated: false }, tl);
    const { result, rerender } = renderHook(({ p }: { p: FakePlayer }) => useReplayTelemetry(DEVICE, p.core), {
      wrapper,
      initialProps: { p: p1 },
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error?.code).toBe("FORBIDDEN");
    await waitFor(() => expect(f.keys().filter((k) => k === SEG_KEYS[0]).length).toBeGreaterThan(0));
    // Overview AND window 403'd; the seam fired once.
    expect(p1.notifyUrlsExpired).toHaveBeenCalledTimes(1);

    // The refresh the seam queued brings fresh URLs.
    forbidden = false;
    const p2 = player({ sessions: [session({ sig: "fresh" })], truncated: false }, tl);
    rerender({ p: p2 });
    await waitFor(() => expect(result.current.hasGps).toBe(true));
    expect(result.current.error).toBeNull();
    expect(p2.notifyUrlsExpired).not.toHaveBeenCalled();
  });
});

describe("useReplayTelemetry: REST fallback", () => {
  function row(tsMs: number, metric: string, value: number): TelemetryReading {
    return { ts: new Date(tsMs).toISOString(), metric: metric as MetricName, value, unit: null };
  }

  it("allSettled: a throttled group does not wipe the others", async () => {
    stubFetch();
    const T0 = 1_786_314_000_000;
    const fetchTelemetry = vi.fn(async (_id: string, params: { metric?: string[]; interval?: number }) => {
      const group = params.metric?.[0]?.split(".")[0];
      if (group === "system") throw new Error("503 Service Unavailable");
      const readings: TelemetryReading[] = [];
      for (let i = 0; i < 20; i++) {
        readings.push(row(T0 + i * 10_000, "gps.lat", 43 + i * 0.001), row(T0 + i * 10_000, "gps.lon", -79.5));
      }
      return { readings, bucketSeconds: params.interval ?? null, truncated: false } satisfies TelemetryHistory;
    });
    const p = player(null, timelineOf(T0, T0 + 200_000));
    const { result } = renderHook(
      () =>
        useReplayTelemetry(DEVICE, p.core, {
          metrics: ["gps.lat", "gps.lon", "system.cpu_temp"] as MetricName[],
          fetchTelemetry: fetchTelemetry as never,
        }),
      { wrapper },
    );
    expect(result.current.source).toBe("rest");
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.hasGps).toBe(true);
    expect(result.current.routeLines.reduce((n, l) => n + l.length, 0)).toBe(20);
  });

  it("error when every group failed", async () => {
    stubFetch();
    const fetchTelemetry = vi.fn(async () => {
      throw new Error("503");
    });
    const p = player(null, timelineOf(1_000, 200_000));
    const { result } = renderHook(
      () =>
        useReplayTelemetry(DEVICE, p.core, {
          metrics: ["gps.lat", "system.cpu_temp"] as MetricName[],
          fetchTelemetry: fetchTelemetry as never,
        }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error?.code).toBe("NETWORK");
  });
});

void act;
