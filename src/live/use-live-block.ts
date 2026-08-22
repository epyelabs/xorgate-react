import { useEffect, useMemo, useState } from "react";
import { resolveLiveBlock, type LiveBlockState } from "./live-block.js";
import type { UseLiveTelemetry } from "./use-live-telemetry.js";

/**
 * Re-evaluate the block once a second. This exists for one case no telemetry
 * event can cover: the DEVICE goes quiet while the broker connection stays up.
 * Nothing arrives, so nothing re-renders, so a purely event-driven gate would
 * latch its last verdict forever. The tick ages it out (LIVE_BLOCK_STALE_MS)
 * and keeps `elapsedMs` advancing.
 */
const TICK_MS = 1000;

/**
 * `resolveLiveBlock` with the two things a pure function cannot have: the
 * current time, and a reason to re-render when time is the only thing that
 * changed. Ticks at 1 Hz, and only while a tick could change the answer.
 */
export function useLiveBlock(
  feed: Pick<UseLiveTelemetry, "status" | "recording" | "receivedAt">,
): LiveBlockState {
  const { status, recording, receivedAt } = feed;
  const [now, setNow] = useState(() => Date.now());

  // Only tick while a tick can change the answer: a connected feed with a
  // payload in hand is the only state where time alone matters.
  const ticking = status === "connected" && receivedAt !== null;
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [ticking]);

  return useMemo(
    () => resolveLiveBlock({ status, recording, receivedAt, now }),
    [status, recording, receivedAt, now],
  );
}
