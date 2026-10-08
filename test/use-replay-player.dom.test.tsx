// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { createElement, StrictMode, useEffect, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplayManifest } from "@xorgate/sdk";
import { ReplayVideo } from "../src/replay/replay-video.js";
import { useReplayPlayer, type UseReplayPlayer } from "../src/replay/use-replay-player.js";
import {
  useReplayPlayerCore,
  type UseReplayPlayerCore,
} from "../src/replay/use-replay-player-core.js";
import type { ReplayEngine, ReplayEngineFactory } from "../src/replay/replay-engine.js";

/**
 * How many engines a lane gets, and how many segment requests that costs,
 * across every way a consumer attaches media: the browser's `laneVideoRef`
 * (a ref callback, through the real `MseEngine` over a stubbed `fetch`) and a
 * platform wrapper that attaches from an effect keyed on `attachLane`, which
 * is what `@xorgate/react-native` does. Each runs with and without
 * `StrictMode`, because both web consoles mount under it and it is exactly
 * the double attach/detach a lane's bookkeeping has to survive.
 *
 * The invariant: one live engine per attached lane, and a segment is
 * requested once per engine. A lane started and torn down inside one commit
 * still costs a real request on a phone, where cancelling the native load
 * does not stop its download.
 */

const FROM = 1_760_000_000_000;

function manifest(sessionId = "session-0", sig = "a"): ReplayManifest {
  return {
    deviceId: "dev-1",
    from: FROM,
    to: FROM + 180_000,
    urlExpiresAt: Date.now() + 3600_000,
    sessions: [
      {
        id: sessionId,
        streamKey: "cam0",
        status: "closed",
        timeSource: "ntp",
        codec: "avc1.42C028",
        width: 1280,
        height: 720,
        fps: 15,
        gaps: [],
        segments: [0, 1, 2].map((seq) => ({
          seq,
          startTs: FROM + seq * 60_000,
          effectiveDurationMs: 60_000,
          finalized: true,
          anchor: "boundary" as const,
          sizeBytes: null,
          url: `https://s3.example/${sessionId}/cam0-${seq}.mp4?sig=${sig}`,
        })),
      },
    ],
  } as unknown as ReplayManifest;
}

/** Every segment request the MSE engine makes, and whether it was aborted. */
interface Request {
  path: string;
  aborted: boolean;
}
let requests: Request[] = [];

beforeEach(() => {
  requests = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: { signal?: AbortSignal }) => {
      const request: Request = { path: new URL(url).pathname, aborted: false };
      requests.push(request);
      // Never resolves: the count of requests is the subject, not the media.
      return new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          request.aborted = true;
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    }),
  );
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await act(async () => Promise.resolve());
}

const live = () => requests.filter((r) => !r.aborted).map((r) => r.path).sort();
const all = () => requests.map((r) => r.path).sort();

function wrap(strict: boolean, node: ReactNode): ReactNode {
  return strict ? createElement(StrictMode, null, node) : node;
}

// --- the browser: laneVideoRef through the real MseEngine ---------------------

let webPlayer: UseReplayPlayer | null = null;

/**
 * `slot` moves the `<video>` between two parents, the way the xorgate-web
 * console's map/card toggle and alocate-web's responsive layout do: React
 * unmounts one element and mounts another while the hook stays mounted.
 * `slot: null` drops the video and keeps the player.
 */
function WebScreen({ replay, slot }: { replay: ReplayManifest | null; slot: "a" | "b" | null }) {
  const player = useReplayPlayer(replay);
  webPlayer = player;
  const tiles = player.lanes.map((lane) =>
    createElement(ReplayVideo, { key: lane.streamKey, player, streamKey: lane.streamKey }),
  );
  if (slot === null) return createElement("div", null);
  return slot === "a"
    ? createElement("section", null, tiles)
    : createElement("aside", null, tiles);
}

describe.each([false, true])("laneVideoRef (StrictMode=%s)", (strict) => {
  const screen = (replay: ReplayManifest | null, slot: "a" | "b" | null = "a") =>
    wrap(strict, createElement(WebScreen, { replay, slot }));

  it("requests the first segment and its prefetch once each", async () => {
    const view = render(screen(manifest()));
    await flush();
    expect(live()).toEqual(["/session-0/cam0-0.mp4", "/session-0/cam0-1.mp4"]);
    expect(webPlayer?.laneState("cam0").status).toBe("loading");
    view.unmount();
    await flush();
    expect(live()).toEqual([]);
  });

  it("re-signed URLs on the same replay do not restart the lane", async () => {
    const view = render(screen(manifest("session-0", "a")));
    await flush();
    const before = all();
    view.rerender(screen(manifest("session-0", "b")));
    await flush();
    expect(all()).toEqual(before);
    expect(live()).toEqual(["/session-0/cam0-0.mp4", "/session-0/cam0-1.mp4"]);
    view.unmount();
  });

  it("a new replay tears the old lane down and starts one new lane", async () => {
    const view = render(screen(manifest("session-0")));
    await flush();
    view.rerender(screen(manifest("session-1")));
    await flush();
    expect(live()).toEqual(["/session-1/cam0-0.mp4", "/session-1/cam0-1.mp4"]);
    view.unmount();
    await flush();
    expect(live()).toEqual([]);
  });

  it("moving the video to another parent leaves nothing running on the old element", async () => {
    const view = render(screen(manifest(), "a"));
    await flush();
    view.rerender(screen(manifest(), "b"));
    await flush();
    expect(requests.filter((r) => r.aborted)).toHaveLength(2);
    view.unmount();
    await flush();
    expect(live()).toEqual([]);
  });

  it("dropping the video while the player stays mounted stops its lane", async () => {
    const view = render(screen(manifest(), "a"));
    await flush();
    view.rerender(screen(manifest(), null));
    await flush();
    expect(live()).toEqual([]);
    expect(webPlayer?.laneState("cam0").status).toBe("loading");
    view.unmount();
  });

  // KNOWN BUG, separate from the double load: `laneVideoRef` caches each
  // lane's ref callback once, and the callback closes over the FIRST render's
  // `attachLane` — when there was no clock yet. A `<video>` that attaches
  // after that (moved to another parent, or dropped and brought back) gets a
  // lane that never starts. The xorgate-web console's map/card toggle does
  // exactly this. Flip to `it` when it is fixed.
  it.fails("a video that re-attaches later gets a running lane", async () => {
    const view = render(screen(manifest(), "a"));
    await flush();
    view.rerender(screen(manifest(), "b"));
    await flush();
    expect(live()).toEqual(["/session-0/cam0-0.mp4", "/session-0/cam0-1.mp4"]);
    view.unmount();
  });
});

// --- a platform wrapper: attach from an effect keyed on attachLane -------------

/** Engines a factory made, and which of them are still alive. */
let engines: Array<{ destroyed: boolean; ensured: number }> = [];

const fakeFactory: ReplayEngineFactory = () => {
  const record = { destroyed: false, ensured: 0 };
  engines.push(record);
  const engine: ReplayEngine = {
    position: 0,
    paused: true,
    ensureAt: () => {
      record.ensured++;
    },
    isBufferedAt: () => false,
    buffered: () => [],
    seek: () => undefined,
    play: () => undefined,
    pause: () => undefined,
    setRate: () => undefined,
    isStalled: () => true,
    on: () => () => undefined,
    destroy: () => {
      record.destroyed = true;
    },
  };
  return engine;
};

let nativePlayer: UseReplayPlayerCore | null = null;

/** `@xorgate/react-native`'s attach, reduced to its shape. */
function NativeScreen({ replay }: { replay: ReplayManifest | null }) {
  const core = useReplayPlayerCore(replay);
  nativePlayer = core;
  const { lanes, attachLane } = core;
  const laneKeys = lanes.map((lane) => lane.streamKey).join("\u0000");
  useEffect(() => {
    const keys = laneKeys === "" ? [] : laneKeys.split("\u0000");
    const detachers = keys.map((key) => attachLane(key, fakeFactory));
    return () => {
      for (const detach of detachers) detach();
    };
  }, [laneKeys, attachLane]);
  return null;
}

describe.each([false, true])("attach from an effect (StrictMode=%s)", (strict) => {
  beforeEach(() => {
    engines = [];
  });
  const screen = (replay: ReplayManifest | null) =>
    wrap(strict, createElement(NativeScreen, { replay }));
  const alive = () => engines.filter((e) => !e.destroyed);
  // An engine that was asked for media before it died cost a request.
  const wasted = () => engines.filter((e) => e.destroyed && e.ensured > 0);

  it("starts exactly one engine for the lane, and never a throwaway one", async () => {
    const view = render(screen(manifest()));
    await flush();
    expect(alive()).toHaveLength(1);
    expect(wasted()).toHaveLength(0);
    expect(nativePlayer?.lanes).toHaveLength(1);
    view.unmount();
    await flush();
    expect(alive()).toHaveLength(0);
  });

  it("a new replay leaves exactly one engine running", async () => {
    const view = render(screen(manifest("session-0")));
    await flush();
    view.rerender(screen(manifest("session-1")));
    await flush();
    expect(alive()).toHaveLength(1);
    view.unmount();
    await flush();
    expect(alive()).toHaveLength(0);
  });

  // KNOWN, separate from the double load: a new manifest rebuilds `lanes` in
  // render, but the new clock is set from an effect, so for one commit the
  // lane starts against the OLD clock and is then restarted. A browser aborts
  // that fetch; a native player may not. A consumer that remounts per replay
  // (alocate-mobile keys its replay by window) never takes this path. Flip to
  // `it` when the core stops starting a lane on a clock from another replay.
  it.fails("a new replay starts no throwaway engine in between", async () => {
    const view = render(screen(manifest("session-0")));
    await flush();
    const first = engines.length;
    view.rerender(screen(manifest("session-1")));
    await flush();
    expect(engines.length - first).toBe(1);
    view.unmount();
  });

  it("re-signed URLs on the same replay keep the engine", async () => {
    const view = render(screen(manifest("session-0", "a")));
    await flush();
    const first = engines.length;
    view.rerender(screen(manifest("session-0", "b")));
    await flush();
    expect(engines.length).toBe(first);
    expect(alive()).toHaveLength(1);
    view.unmount();
  });
});
