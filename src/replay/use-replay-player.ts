import { useCallback, useRef } from "react";
import type { RefCallback } from "react";
import type { ReplayManifest, StreamKey } from "@xorgate/sdk";
import { MseEngine } from "./mse-engine.js";
import {
  useReplayPlayerCore,
  type UseReplayPlayerCore,
  type UseReplayPlayerOptions,
} from "./use-replay-player-core.js";

export type {
  ReplayLaneState,
  ReplayLaneStatus,
  UseReplayPlayerOptions,
} from "./use-replay-player-core.js";

export interface UseReplayPlayer extends UseReplayPlayerCore {
  /**
   * Attach a `<video>` to one lane. The returned ref callback is stable per
   * `streamKey`, so it is safe inline in a map. Everything MSE-side starts
   * when the element attaches and stops when it detaches.
   */
  laneVideoRef: (streamKey: StreamKey) => RefCallback<HTMLVideoElement>;
}

/**
 * The headless replay player: MSE plumbing plus the clock, no chrome.
 *
 * Playback is fMP4 over Media Source Extensions, so this is browser-only and
 * there is no URL you can hand to another player. This is the browser
 * wrapper over `useReplayPlayerCore`; React Native consumers use
 * `@xorgate/react-native`'s `useReplayPlayer`, which drives native players
 * through the same core.
 */
export function useReplayPlayer(
  manifest: ReplayManifest | null | undefined,
  options: UseReplayPlayerOptions = {},
): UseReplayPlayer {
  const core = useReplayPlayerCore(manifest, options);
  const { attachLane } = core;

  const attached = useRef(new Map<string, { element: HTMLVideoElement; detach: () => void }>());
  const refCallbacks = useRef(new Map<string, RefCallback<HTMLVideoElement>>());

  const laneVideoRef = useCallback(
    (streamKey: StreamKey): RefCallback<HTMLVideoElement> => {
      let cb = refCallbacks.current.get(streamKey);
      if (!cb) {
        cb = (element: HTMLVideoElement | null) => {
          const existing = attached.current.get(streamKey);
          if (element === null) {
            if (existing) {
              existing.detach();
              attached.current.delete(streamKey);
            }
            return;
          }
          if (existing?.element === element) return;
          existing?.detach();
          const detach = attachLane(streamKey, (opts) => new MseEngine({ video: element, ...opts }));
          attached.current.set(streamKey, { element, detach });
        };
        refCallbacks.current.set(streamKey, cb);
      }
      return cb;
    },
    [attachLane],
  );

  return { ...core, laneVideoRef };
}
