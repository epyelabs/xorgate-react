import { describe, expect, it } from "vitest";
import {
  LIVE_BLOCK_STALE_MS,
  liveBlockElapsedMs,
  resolveLiveBlock,
} from "../src/live/live-block.js";
import { parseTelemetryPayload } from "../src/live/payload.js";

/**
 * Ported from xorgate-web's exhaustive table, minus everything that stayed
 * app-side on purpose (the reason-to-descriptor registry, copy, icons and
 * tile precedence). What the SDK owns is the VERDICT: fail-open on every kind
 * of absence, honour an unknown reason anyway, and never trust the device's
 * clock for elapsed time.
 */

const NOW = 1_754_400_000_000;

function recordingWith(
  liveBlock?: { reason: string; detail: string; since: number },
  powerShed?: string,
) {
  return {
    ...(liveBlock ? { liveBlock } : {}),
    ...(powerShed ? { powerShed } : {}),
  };
}

describe("resolveLiveBlock — fail open on absence", () => {
  const blocked = {
    reason: "thermal",
    detail: "cpu 66.1C >= 60C for 5s",
    since: NOW - 120_000,
  };

  it.each(["connecting", "closed", "error", "unavailable"] as const)(
    "feed status %s never blocks, even with a live block in hand",
    (status) => {
      const state = resolveLiveBlock({
        status,
        recording: recordingWith(blocked),
        receivedAt: NOW - 500,
        now: NOW,
      });
      expect(state).toEqual({ blocked: false, why: "feed-not-connected" });
    },
  );

  it("no payload yet does not block", () => {
    expect(
      resolveLiveBlock({ status: "connected", recording: null, receivedAt: null, now: NOW }),
    ).toEqual({ blocked: false, why: "no-payload" });
  });

  it("a recording block with no receipt time does not block", () => {
    // Defensive: a caller that forgets the clock must not get a verdict it
    // cannot age out.
    expect(
      resolveLiveBlock({
        status: "connected",
        recording: recordingWith(blocked),
        receivedAt: null,
        now: NOW,
      }),
    ).toEqual({ blocked: false, why: "no-payload" });
  });

  it("a payload older than the staleness window does not block", () => {
    expect(
      resolveLiveBlock({
        status: "connected",
        recording: recordingWith(blocked),
        receivedAt: NOW - LIVE_BLOCK_STALE_MS,
        now: NOW,
      }),
    ).toEqual({ blocked: false, why: "stale-payload" });
  });

  it("a payload just inside the staleness window still blocks", () => {
    const state = resolveLiveBlock({
      status: "connected",
      recording: recordingWith(blocked),
      receivedAt: NOW - LIVE_BLOCK_STALE_MS + 1,
      now: NOW,
    });
    expect(state.blocked).toBe(true);
  });

  it("an agent too old to send liveBlock does not block", () => {
    expect(
      resolveLiveBlock({ status: "connected", recording: {}, receivedAt: NOW - 500, now: NOW }),
    ).toEqual({ blocked: false, why: "no-live-block" });
  });

  it("a MALFORMED recording block arrives as null and does not block", () => {
    // The payload validator treats a malformed recording block as absent, so
    // "bad block" and "no block" are the same case by construction.
    const parsed = parseTelemetryPayload({
      v: 1,
      deviceId: "dev-1",
      ts: NOW,
      metrics: {},
      recording: { enabled: "not-a-boolean", liveBlock: { reason: "thermal" } },
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.recording).toBeNull();
    expect(
      resolveLiveBlock({
        status: "connected",
        recording: parsed!.recording,
        receivedAt: NOW - 500,
        now: NOW,
      }),
    ).toEqual({ blocked: false, why: "no-payload" });
  });
});

describe("resolveLiveBlock — the verdict is data, and unknown reasons block", () => {
  it.each(["gps-gate", "undervoltage", "thermal"] as const)("%s blocks with its reason", (reason) => {
    const state = resolveLiveBlock({
      status: "connected",
      recording: recordingWith({ reason, detail: "device prose", since: NOW }),
      receivedAt: NOW,
      now: NOW,
    });
    expect(state.blocked).toBe(true);
    if (!state.blocked) return;
    expect(state.reason).toBe(reason);
  });

  it("an UNKNOWN reason still blocks", () => {
    // A newer device against an older frontend is a normal deployment state,
    // and it is the one deliberate exception to fail-open: the device said
    // blocked, so we honour it.
    const state = resolveLiveBlock({
      status: "connected",
      recording: recordingWith({
        reason: "future-thing",
        detail: "something the device knows about and we do not",
        since: NOW,
      }),
      receivedAt: NOW,
      now: NOW,
    });
    expect(state.blocked).toBe(true);
    if (!state.blocked) return;
    expect(state.reason).toBe("future-thing");
    expect(state.detail).toBe("something the device knows about and we do not");
  });

  it("carries the device's detail through verbatim, unparsed", () => {
    const detail = "rail 5.11V < 5.2V for 3s";
    const state = resolveLiveBlock({
      status: "connected",
      recording: recordingWith({ reason: "undervoltage", detail, since: NOW }),
      receivedAt: NOW,
      now: NOW,
    });
    expect(state.blocked && state.detail).toBe(detail);
  });
});

describe("resolveLiveBlock — parked", () => {
  it("reports a parked shed", () => {
    const state = resolveLiveBlock({
      status: "connected",
      recording: recordingWith(
        { reason: "thermal", detail: "cpu 81.0C >= 80C for 15s", since: NOW },
        "parked:no-live",
      ),
      receivedAt: NOW,
      now: NOW,
    });
    expect(state.blocked && state.parked).toBe(true);
  });

  it("an unparked shed is not parked", () => {
    const state = resolveLiveBlock({
      status: "connected",
      recording: recordingWith(
        { reason: "thermal", detail: "cpu 81.0C >= 80C for 15s", since: NOW },
        "no-live",
      ),
      receivedAt: NOW,
      now: NOW,
    });
    expect(state.blocked && state.parked).toBe(false);
  });
});

describe("liveBlockElapsedMs — the device's clock is not ours", () => {
  it("reports a plausible age", () => {
    expect(liveBlockElapsedMs(NOW - 125_000, NOW)).toBe(125_000);
  });

  it("refuses a NEGATIVE age (device clock ahead of the browser)", () => {
    expect(liveBlockElapsedMs(NOW + 60_000, NOW)).toBeNull();
  });

  it("refuses an implausible age (device clock stuck at the epoch)", () => {
    expect(liveBlockElapsedMs(0, NOW)).toBeNull();
  });

  it("a skewed clock costs elapsedMs, not the block", () => {
    const state = resolveLiveBlock({
      status: "connected",
      recording: recordingWith({
        reason: "thermal",
        detail: "cpu 81.0C >= 80C for 15s",
        since: 0, // device booted with no RTC and never synced
      }),
      receivedAt: NOW,
      now: NOW,
    });
    expect(state.blocked).toBe(true);
    expect(state.blocked && state.elapsedMs).toBeNull();
  });

  it("reports elapsedMs on the verdict", () => {
    const state = resolveLiveBlock({
      status: "connected",
      recording: recordingWith({ reason: "thermal", detail: "d", since: NOW - 125_000 }),
      receivedAt: NOW,
      now: NOW,
    });
    expect(state.blocked && state.elapsedMs).toBe(125_000);
  });
});
