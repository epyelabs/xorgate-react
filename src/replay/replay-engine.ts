import type { ReplaySegment } from "@xorgate/sdk";
import type { ReplayTimeline } from "./timeline.js";

/**
 * What the replay player core needs from a lane's media, and nothing about
 * HOW it is played. The browser engine (`MseEngine`) is one `<video>` over
 * Media Source Extensions; `@xorgate/react-native`'s engine is two native
 * players over expo-video. The core hook drives either through this surface:
 * positions are lane-local SECONDS (from the lane timeline's `from`), the
 * wall clock stays the core's business.
 */
export interface ReplayEngine {
  /** Lane-local seconds the media currently shows. */
  readonly position: number;
  readonly paused: boolean;
  /**
   * Make sure the media around wall-clock `ts` is fetched/preloaded. Called at
   * clock-notify rate and from a 500 ms pump: steady state must do no work.
   */
  ensureAt(ts: number): void;
  /** Whether `posSec` is playable right now, by the media's own truth. */
  isBufferedAt(posSec: number): boolean;
  /** Buffered ranges in lane-local seconds, ascending. */
  buffered(): Array<{ start: number; end: number }>;
  seek(posSec: number): void;
  play(): void;
  pause(): void;
  setRate(rate: number): void;
  /** The media cannot advance right now (buffer underrun). */
  isStalled(): boolean;
  /**
   * `waiting`: a stall began while playing. `firstFrame`: the first frame is
   * decoded and the lane can be shown. Returns the unsubscribe.
   */
  on(event: "waiting" | "firstFrame", cb: () => void): () => void;
  destroy(): void;
}

/** What the core hands a lane engine factory. */
export interface ReplayEngineOptions {
  /** The LANE's timeline (lane-local coverage over the shared replay bounds). */
  timeline: ReplayTimeline;
  /** The presigned URL for a segment, refreshed by the core on a manifest reload. */
  getUrl: (segment: ReplaySegment) => string;
  onError: (message: string) => void;
  /** Buffered media changed: the core re-evaluates the lane. */
  onUpdate: () => void;
  /** A segment fetch was refused (403): the presigned URLs have lapsed. */
  onAuthError?: () => void;
}

export type ReplayEngineFactory = (options: ReplayEngineOptions) => ReplayEngine;
