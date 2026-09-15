import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReplayManifest, StreamKey, XorgateError } from "@xorgate/sdk";
import { buildClockTimeline, buildLanes, segmentUrlKey, type LaneSegment, type ReplayLane } from "./lanes.js";
import { ReplayClock, type GapSkipEvent, type ReplayRate } from "./replay-clock.js";
import type { ReplayEngine, ReplayEngineFactory } from "./replay-engine.js";
import {
  hasCoverageAt,
  nextBoundary,
  nextSegmentAfter,
  prevBoundary,
  segmentAt,
  segmentEnd,
  type ReplayTimeline,
} from "./timeline.js";
import { MANIFEST_REFRESH } from "./use-replay-manifest.js";

export type ReplayLaneStatus = "loading" | "ready" | "error";

export interface ReplayLaneState {
  streamKey: StreamKey;
  status: ReplayLaneStatus;
  /**
   * The playhead is in a stretch THIS lane does not cover. Per-lane by
   * design: one camera dark while another plays is not a replay-level gap.
   */
  inGap: boolean;
  /** True while this lane's media is the one driving the clock. */
  isPacer: boolean;
  error: XorgateError | null;
}

export interface UseReplayPlayerOptions {
  /** Where to start. Clamped into the manifest window. Default `manifest.from`. */
  startTs?: number;
  /** Default 1. */
  rate?: ReplayRate;
  /** Default true. */
  skipGaps?: boolean;
  /**
   * How often the hook re-renders with a new `playheadTs`. Default 100. The
   * clock itself notifies at rAF rate; a component that needs every tick
   * should `player.clock.subscribe()` instead.
   */
  throttleMs?: number;
  /** Called when a segment fetch 403s, after the automatic manifest refresh is queued. */
  onUrlsExpired?: () => void;
}

/**
 * The engine-agnostic player: everything `useReplayPlayer` returns except the
 * browser's `laneVideoRef`, plus `attachLane`, the seam a platform wrapper
 * binds its media through.
 */
export interface UseReplayPlayerCore {
  /** Null until a manifest arrives. Every field below is inert while it is null. */
  clock: ReplayClock | null;
  /** The merged clock timeline: coverage across ALL lanes. */
  timeline: ReplayTimeline | null;
  lanes: ReplayLane[];

  /** Throttled snapshot. `playheadTs` is epoch ms. */
  playheadTs: number;
  playing: boolean;
  rate: ReplayRate;
  skipGaps: boolean;
  /** The most recent gap the clock jumped, for a transient notice. */
  lastSkip: GapSkipEvent | null;

  play: () => void;
  pause: () => void;
  toggle: () => void;
  seek: (ts: number) => void;
  setRate: (rate: ReplayRate) => void;
  setSkipGaps: (skip: boolean) => void;
  /** Jump to the previous or next boundary: a segment start or the far side of a gap. */
  stepBoundary: (direction: -1 | 1) => void;

  /**
   * Bind media to one lane. The factory is called with the lane's timeline
   * and URL resolver (again whenever the replay rebuilds); the engine it
   * returns is driven until the returned detach function runs. A browser
   * wrapper calls this from a `<video>` ref callback with an MSE engine; a
   * React Native wrapper with native players. Attaching a second time for
   * the same lane replaces the first.
   */
  attachLane: (streamKey: StreamKey, createEngine: ReplayEngineFactory) => () => void;
  /** Per-lane render state. Returns a `loading`, non-gap default for an unknown key. */
  laneState: (streamKey: StreamKey) => ReplayLaneState;
}

// Micro-gap jump ceiling: buffered holes at rotation seams are ≤ ~2 s (fstat
// anchors); anything a jump cannot reach within this is the clock's business.
const MICRO_GAP_MAX_S = 5;
// A paused playhead sitting this close before the lane's next segment is not
// "no video" — composite lanes start milliseconds apart, so park the media
// on the upcoming first frame as a poster instead of showing a gap state.
const NEAR_COVERAGE_MS = 2_500;
// While paused (or while the pacer stalls on a cold fetch) the clock emits no
// notifies; this pump retries fetches and keeps prefetch warm.
const PUMP_MS = 500;

interface LaneRuntime {
  createEngine: ReplayEngineFactory;
  cleanup: () => void;
}

/**
 * The headless replay player core: the clock, the lane runtimes and the
 * transport, over any `ReplayEngine`. A manifest refetch that describes the
 * SAME replay (same device, window and session set) swaps the presigned URLs
 * without rebuilding the timeline or resetting the clock; a different
 * session set is a new replay and rebuilds.
 */
export function useReplayPlayerCore(
  manifest: ReplayManifest | null | undefined,
  options: UseReplayPlayerOptions = {},
): UseReplayPlayerCore {
  const { startTs, rate: initialRate, skipGaps: initialSkipGaps, throttleMs = 100 } = options;
  const onUrlsExpiredRef = useRef(options.onUrlsExpired);
  onUrlsExpiredRef.current = options.onUrlsExpired;

  // --- replay identity: rebuild lanes/timeline/clock ONLY when it changes ---
  const replayKey = manifest ? keyOf(manifest) : null;

  // The manifest that BUILT the current replay. URL refreshes update only the
  // url map below.
  const builtManifestRef = useRef<ReplayManifest | null>(null);
  if (replayKey !== null && manifest) {
    if (!builtManifestRef.current || keyOf(builtManifestRef.current) !== replayKey) {
      builtManifestRef.current = manifest;
    }
  } else {
    builtManifestRef.current = null;
  }
  const builtManifest = builtManifestRef.current;

  const lanes = useMemo(() => (builtManifest ? buildLanes(builtManifest) : []), [builtManifest]);
  const timeline = useMemo(
    () =>
      builtManifest ? buildClockTimeline(lanes, builtManifest.from, builtManifest.to) : null,
    [builtManifest, lanes],
  );

  // --- presigned URL map: refreshed on EVERY manifest change ---
  const urlMapRef = useRef(new Map<string, string>());
  useMemo(() => {
    if (!manifest) return;
    const map = urlMapRef.current;
    for (const session of manifest.sessions) {
      for (const seg of session.segments) {
        map.set(segmentUrlKey(session.id, seg.seq), seg.url);
      }
    }
  }, [manifest]);

  // The latest manifest object carries the refresh seam when it came from
  // useReplayManifest; a proxied consumer refreshes by passing a new object.
  const manifestRef = useRef(manifest);
  manifestRef.current = manifest;

  // --- the clock, one per replay ---
  const [clock, setClock] = useState<ReplayClock | null>(null);
  useEffect(() => {
    if (!timeline) {
      setClock(null);
      return;
    }
    const c = new ReplayClock(timeline, startTs);
    if (initialRate !== undefined) c.setRate(initialRate);
    if (initialSkipGaps !== undefined) c.setSkipGaps(initialSkipGaps);
    setClock(c);

    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      // Clamp dt: rAF stops in background tabs, and an un-clamped catch-up
      // tick would free-run the playhead minutes ahead on return.
      const dt = Math.min(now - last, 250);
      last = now;
      c.tick(dt);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      setClock(null);
    };
    // startTs/rate/skipGaps are INITIAL values by contract; changing them
    // mid-replay goes through the transport methods.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeline]);

  // --- throttled snapshot for rendering ---
  const [snap, setSnap] = useState(() => ({
    playheadTs: timeline?.from ?? 0,
    playing: false,
    rate: (initialRate ?? 1) as ReplayRate,
    skipGaps: initialSkipGaps ?? true,
    lastSkip: null as GapSkipEvent | null,
  }));
  const lastRender = useRef(0);
  const trailing = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!clock) return;
    const push = () => {
      lastRender.current = performance.now();
      const s = clock.getState();
      setSnap({
        playheadTs: s.playheadTs,
        playing: s.playing,
        rate: s.rate,
        skipGaps: s.skipGaps,
        lastSkip: s.lastSkip,
      });
    };
    push();
    const unsubscribe = clock.subscribe(() => {
      const since = performance.now() - lastRender.current;
      if (since >= throttleMs) {
        if (trailing.current) {
          clearTimeout(trailing.current);
          trailing.current = null;
        }
        push();
      } else if (!trailing.current) {
        // Trailing edge, so the last event of a burst (pause, seek release)
        // always lands.
        trailing.current = setTimeout(() => {
          trailing.current = null;
          push();
        }, throttleMs - since);
      }
    });
    return () => {
      unsubscribe();
      if (trailing.current) clearTimeout(trailing.current);
    };
  }, [clock, throttleMs]);

  // --- lane runtimes -------------------------------------------------------
  const laneStates = useRef(new Map<string, ReplayLaneState>());
  const [, bumpLaneVersion] = useState(0);
  const runtimes = useRef(new Map<string, LaneRuntime>());

  const setLaneState = useCallback((streamKey: string, patch: Partial<ReplayLaneState>) => {
    const prev =
      laneStates.current.get(streamKey) ??
      ({ streamKey, status: "loading", inGap: false, isPacer: false, error: null } as ReplayLaneState);
    const next = { ...prev, ...patch };
    if (
      prev.status !== next.status ||
      prev.inGap !== next.inGap ||
      prev.isPacer !== next.isPacer ||
      prev.error !== next.error
    ) {
      laneStates.current.set(streamKey, next);
      bumpLaneVersion((v) => v + 1);
    }
  }, []);

  const startLane = useCallback(
    (streamKey: string, createEngine: ReplayEngineFactory): (() => void) | null => {
      if (!clock) return null;
      const lane = lanes.find((l) => l.streamKey === streamKey);
      if (!lane) return null;
      const laneTimeline = lane.timeline;

      let firstFrameSeen = false;
      let engine: ReplayEngine | null = null;
      const onClockChange = () => {
        if (!engine) return;
        const media = engine;
        const st = clock.getState();
        const cover = segmentAt(laneTimeline, st.playheadTs);
        const pos = (st.playheadTs - laneTimeline.from) / 1000;

        if (!cover) {
          // Paused a hair before this lane's coverage: park the media on the
          // upcoming first frame as a poster instead of a false gap state.
          const next = nextSegmentAfter(laneTimeline, st.playheadTs);
          if (!st.playing && next !== null && next.startTs - st.playheadTs <= NEAR_COVERAGE_MS) {
            setLaneState(streamKey, { inGap: false, isPacer: false });
            const posterPos = (next.startTs - laneTimeline.from) / 1000 + 0.05;
            if (Math.abs(media.position - posterPos) > 0.05) {
              media.seek(posterPos);
            }
          } else {
            setLaneState(streamKey, { inGap: true, isPacer: false });
          }
          if (!media.paused) media.pause();
          // Keep the far side warm so resuming out of the gap is instant.
          media.ensureAt(st.playheadTs);
          // Consume seeks that happened while uncovered; re-entry realigns.
          lastSeekSeq = st.seekSeq;
          pendingAlign = true;
          return;
        }
        const pacing = st.playing && clock.pacerId() === streamKey;
        setLaneState(streamKey, { inGap: false, isPacer: pacing });
        media.ensureAt(st.playheadTs);

        // Elected pacer drives the clock; everyone else chases it and re-seeks
        // past the drift ceiling.
        const drift = Math.abs(media.position - pos);
        if (st.seekSeq !== lastSeekSeq || pendingAlign || (!pacing && drift > 0.15)) {
          lastSeekSeq = st.seekSeq;
          pendingAlign = false;
          if (drift > 0.05) media.seek(pos);
        }
        media.setRate(st.rate);
        if (st.playing && media.paused) {
          media.play();
        } else if (!st.playing && !media.paused) {
          media.pause();
        }
        // Established-stall probe: a stalled pacer emits no clock notifies, so
        // this effectively runs at the pump rate.
        if (pacing && !media.paused && media.isStalled()) {
          recoverStall();
        }
      };

      engine = createEngine({
        timeline: laneTimeline,
        getUrl: (seg) =>
          urlMapRef.current.get(segmentUrlKey((seg as LaneSegment).sessionId, seg.seq)) ?? seg.url,
        onError: (message) => {
          setLaneState(streamKey, {
            status: "error",
            error: Object.assign(new Error(message), { code: "MEDIA" }) as unknown as XorgateError,
          });
        },
        onUpdate: () => onClockChange(),
        onAuthError: () => {
          // Queue the automatic manifest refresh (when the manifest came from
          // useReplayManifest), then tell the app.
          const current = manifestRef.current as
            | (ReplayManifest & { [MANIFEST_REFRESH]?: () => Promise<void> })
            | null
            | undefined;
          void current?.[MANIFEST_REFRESH]?.();
          onUrlsExpiredRef.current?.();
        },
      });
      const media: ReplayEngine = engine;

      let lastSeekSeq = -1;
      let pendingAlign = true;

      // The media paces the clock only while elected; registration is
      // unconditional, the clock decides. `covers` is the LANE's coverage.
      const unregisterPacer = clock.registerPacer(streamKey, {
        read: () => laneTimeline.from + media.position * 1000,
        covers: (ts) => hasCoverageAt(laneTimeline, ts),
      });

      const unsubscribe = clock.subscribe(onClockChange);

      // Micro-gap jump controller: the media stalls at ANY buffered hole and
      // never self-recovers. Sub-5 s holes get nudged past; a stall with
      // nothing ahead inside claimed coverage means a crash-cut landed short —
      // hand the playhead back to the clock at the segment boundary.
      const recoverStall = () => {
        const st = clock.getState();
        if (!st.playing) return;
        // Followers never steer the clock or jump ahead of it.
        if (clock.pacerId() !== streamKey) return;
        const t = media.position;
        const ranges = media.buffered();
        let nextStart: number | null = null;
        for (const r of ranges) {
          if (r.start > t + 0.05) {
            nextStart = r.start;
            break;
          }
        }
        if (nextStart !== null && nextStart - t < MICRO_GAP_MAX_S) {
          media.seek(nextStart + 0.05);
          return;
        }
        // Boundary-reached ONLY when this segment's media was really
        // consumed: some buffered range must end right at the stall point. A
        // stall with nothing buffered here is just a cold fetch in progress.
        const cover = segmentAt(laneTimeline, st.playheadTs);
        if (cover) {
          for (const r of ranges) {
            if (r.end > t - 0.5 && r.end < t + 0.3) {
              clock.seek(segmentEnd(cover.segment));
              return;
            }
          }
        }
      };
      // `waiting` only covers stalls that BEGIN while playing; the pump probes
      // for established stalls too (the media says it cannot advance) and
      // runs the same recovery.
      const offWaiting = media.on("waiting", recoverStall);
      const offFirstFrame = media.on("firstFrame", () => {
        if (!firstFrameSeen) {
          firstFrameSeen = true;
          setLaneState(streamKey, { status: "ready" });
        }
      });

      // Kick off: fetch what the initial playhead needs and render its frame.
      onClockChange();
      const pump = setInterval(onClockChange, PUMP_MS);

      return () => {
        clearInterval(pump);
        unsubscribe();
        unregisterPacer();
        offWaiting();
        offFirstFrame();
        media.destroy();
        engine = null;
        setLaneState(streamKey, { status: "loading", isPacer: false });
      };
    },
    [clock, lanes, setLaneState],
  );

  // Restart lane runtimes when the replay (clock/lanes) changes while the
  // media stays attached.
  useEffect(() => {
    for (const [streamKey, runtime] of runtimes.current) {
      runtime.cleanup();
      const cleanup = startLane(streamKey, runtime.createEngine);
      runtimes.current.set(streamKey, {
        createEngine: runtime.createEngine,
        cleanup: cleanup ?? (() => undefined),
      });
    }
    return () => {
      for (const runtime of runtimes.current.values()) runtime.cleanup();
      // Keep the registrations: the factories re-run on the next clock via
      // this effect.
      for (const [key, runtime] of runtimes.current) {
        runtimes.current.set(key, { createEngine: runtime.createEngine, cleanup: () => undefined });
      }
    };
  }, [startLane]);

  const attachLane = useCallback(
    (streamKey: StreamKey, createEngine: ReplayEngineFactory): (() => void) => {
      runtimes.current.get(streamKey)?.cleanup();
      const cleanup = startLane(streamKey, createEngine);
      const runtime: LaneRuntime = { createEngine, cleanup: cleanup ?? (() => undefined) };
      runtimes.current.set(streamKey, runtime);
      return () => {
        // Only the registration this call made: a later attach for the same
        // lane has replaced it, and must not be torn down by the old detach.
        if (runtimes.current.get(streamKey) !== runtime) return;
        runtime.cleanup();
        runtimes.current.delete(streamKey);
      };
    },
    [startLane],
  );

  const laneState = useCallback(
    (streamKey: StreamKey): ReplayLaneState =>
      laneStates.current.get(streamKey) ?? {
        streamKey,
        status: "loading",
        inGap: false,
        isPacer: false,
        error: null,
      },
    [],
  );

  // --- transport ---
  const play = useCallback(() => clock?.play(), [clock]);
  const pause = useCallback(() => clock?.pause(), [clock]);
  const toggle = useCallback(() => {
    if (!clock) return;
    if (clock.getState().playing) clock.pause();
    else clock.play();
  }, [clock]);
  const seek = useCallback((ts: number) => clock?.seek(ts), [clock]);
  const setRate = useCallback((r: ReplayRate) => clock?.setRate(r), [clock]);
  const setSkipGaps = useCallback((s: boolean) => clock?.setSkipGaps(s), [clock]);
  const stepBoundary = useCallback(
    (direction: -1 | 1) => {
      if (!clock || !timeline) return;
      const ts = clock.getState().playheadTs;
      const target = direction === -1 ? prevBoundary(timeline, ts) : nextBoundary(timeline, ts);
      clock.seek(target);
    },
    [clock, timeline],
  );

  return {
    clock,
    timeline,
    lanes,
    playheadTs: snap.playheadTs,
    playing: snap.playing,
    rate: snap.rate,
    skipGaps: snap.skipGaps,
    lastSkip: snap.lastSkip,
    play,
    pause,
    toggle,
    seek,
    setRate,
    setSkipGaps,
    stepBoundary,
    attachLane,
    laneState,
  };
}

function keyOf(manifest: ReplayManifest): string {
  return `${manifest.deviceId}:${manifest.from}:${manifest.to}:${manifest.sessions
    .map((s) => s.id)
    .sort()
    .join(",")}`;
}
