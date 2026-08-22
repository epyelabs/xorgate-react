import type { LiveStatus } from "./telemetry-feed.js";
import type { TelemetryRecordingStatus } from "./payload.js";

/**
 * Live-stream block: the browser side of the device's `recording.liveBlock`
 * verdict. The device parks every video master at once when the GPS/LTE boot
 * gate is armed or the load-shed ladder is at rung 1, and publishes WHY.
 *
 * Two rules govern everything here, and they pull in opposite directions:
 *
 *  1. **Fail open on ABSENCE.** No feed, no payload yet, a stale payload, an
 *     agent too old to send the field — every one of them means SHOW the
 *     player. A gate that blocks on missing information is a worse bug than
 *     the black tile it replaces.
 *  2. **Honour an unrecognised reason.** `reason` is an OPEN string on the
 *     wire. A reason this build has never heard of still BLOCKS, because the
 *     device explicitly said blocked; that is presence, not absence.
 *
 * The verdict is DATA ONLY: no title, no icon, no copy, no settings link.
 * Copy is product voice and belongs to the application.
 */

/** Known reasons get autocomplete; the wire contract stays an open set. */
export type LiveBlockReason = "gps-gate" | "undervoltage" | "thermal" | (string & {});

/** Why the gate resolved to "not blocked". Carried for debugging and tests. */
export type LiveBlockOpenReason =
  | "feed-not-connected"
  | "no-payload"
  | "stale-payload"
  | "no-live-block";

export type LiveBlockState =
  | { blocked: false; why: LiveBlockOpenReason }
  | {
      blocked: true;
      reason: LiveBlockReason;
      /**
       * Device prose, e.g. `cpu 66.1C >= 60C for 5s`. Display verbatim, never
       * parse: it is the rationale that STARTED the block and does not track
       * live numbers.
       */
      detail: string;
      /**
       * How long it has been blocked, or null when the device's clock makes
       * the arithmetic untrustworthy (negative, or 24 h or more).
       */
      elapsedMs: number | null;
      /**
       * The shed has spent its rolling-hour cycle cap. A parked shed does NOT
       * recover on its own: it holds until the device reboots or its power
       * settings change, so copy promising a return is a lie.
       */
      parked: boolean;
    };

/**
 * How old the last telemetry payload may be before the verdict stops counting.
 * The feed is 1 Hz, so 30 s is ~30 missed ticks: comfortably past a hiccup,
 * well short of leaving an operator staring at a stale verdict.
 */
export const LIVE_BLOCK_STALE_MS = 30_000;

/**
 * `since` is epoch ms in the DEVICE's clock domain. A device whose RTC has not
 * synced can publish a `since` that makes the arithmetic absurd or negative;
 * anything outside [0, 24 h) is unusable and reported as null.
 */
const ELAPSED_MAX_MS = 24 * 60 * 60 * 1000;

export interface ResolveLiveBlockInput {
  status: LiveStatus;
  recording: Pick<TelemetryRecordingStatus, "liveBlock" | "powerShed"> | null;
  /** Browser-clock ms when the last payload arrived, or null if none has. */
  receivedAt: number | null;
  /** Browser-clock now. Injected so staleness is testable. */
  now: number;
}

/** Elapsed block duration in ms, or null when the device clock is untrustworthy. */
export function liveBlockElapsedMs(since: number, now: number): number | null {
  if (!Number.isFinite(since) || !Number.isFinite(now)) return null;
  const elapsed = now - since;
  if (elapsed < 0 || elapsed >= ELAPSED_MAX_MS) return null;
  return elapsed;
}

/**
 * Pure. The one place "is live blocked?" is decided. Every early return is a
 * fail-open branch; only the final block is a block.
 */
export function resolveLiveBlock(input: ResolveLiveBlockInput): LiveBlockState {
  const { status, recording, receivedAt, now } = input;

  // The verdict is only meaningful while the feed is live: `connecting`,
  // `closed`, `error` and `unavailable` all mean we cannot know, so we allow.
  if (status !== "connected") return { blocked: false, why: "feed-not-connected" };

  // Nothing has arrived yet, including from an agent too old to send the field.
  if (!recording || receivedAt === null) return { blocked: false, why: "no-payload" };

  // The device went quiet while the broker connection stayed up: the exact
  // shape of "device lost its uplink mid-block". Without this, the verdict
  // would latch blocked with no way to clear.
  if (now - receivedAt >= LIVE_BLOCK_STALE_MS) {
    return { blocked: false, why: "stale-payload" };
  }

  const block = recording.liveBlock;
  if (!block) return { blocked: false, why: "no-live-block" };

  return {
    blocked: true,
    reason: block.reason,
    detail: block.detail,
    elapsedMs: liveBlockElapsedMs(block.since, now),
    parked: recording.powerShed?.startsWith("parked:") === true,
  };
}
