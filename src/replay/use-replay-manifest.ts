import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReplayManifest, StreamKey } from "@xorgate/sdk";
import { useXorgateContext } from "../context.js";
import { useXorgateQuery, type QueryOptions, type QueryResult } from "../query/use-query.js";
import { XorgateError } from "@xorgate/sdk";

export type UseReplayManifestParams =
  | { sessionId: string; from?: never; to?: never; streamKey?: never }
  | {
      sessionId?: never;
      from: string | Date;
      to: string | Date;
      streamKey?: StreamKey;
    };

export interface UseReplayManifestResult extends QueryResult<ReplayManifest> {
  /**
   * Refetch NOW and swap the presigned URLs, without rebuilding the timeline
   * or resetting the clock. `useReplayPlayer` calls this itself on a 403; you
   * call it if you drive the player yourself.
   */
  refreshUrls: () => Promise<void>;
  /** Epoch ms from `manifest.urlExpiresAt`, or null before the first load. */
  urlsExpireAt: number | null;
}

/**
 * Hidden seam between the manifest hook and the player: manifests fetched by
 * `useReplayManifest` carry their own refresh function, so `useReplayPlayer`
 * can trigger a URL refresh on a segment 403 without the two hooks being
 * coupled through props. Non-enumerable on purpose.
 */
export const MANIFEST_REFRESH = Symbol.for("xorgate.replay.refreshUrls");

/**
 * While any session in the manifest is still `open` (the device is still
 * uploading), the manifest is refetched this often so the replay grows:
 * new video URLs, new telemetry segments, and the telemetry overview once
 * the session closes and the server builds it. One segment rotation; polling
 * faster buys nothing.
 */
export const REPLAY_OPEN_POLL_MS = 60_000;

/**
 * Caps enforced upstream: 600 segments in total, and in range mode 10
 * sessions and 24 hours. Exceeding one is a 400 telling you to narrow the
 * request, which arrives here as `error`, not as an empty manifest.
 *
 * The hook re-fetches itself shortly before `urlExpiresAt` (which is already
 * the real TTL minus a 5 minute margin), so a replay left open for an hour
 * keeps working. While any video or telemetry session in the latest manifest
 * is `open` it also polls every {@link REPLAY_OPEN_POLL_MS} (a shorter
 * `refetchIntervalMs` in `options` wins), and stops once every session has
 * closed.
 */
export function useReplayManifest(
  deviceId: string | null,
  params: UseReplayManifestParams | null,
  options?: QueryOptions,
): UseReplayManifestResult {
  const { rest } = useXorgateContext();
  void rest;

  const key =
    deviceId === null || params === null
      ? null
      : params.sessionId !== undefined
        ? `replay-manifest:${deviceId}:session:${params.sessionId}`
        : `replay-manifest:${deviceId}:range:${iso(params.from)}:${iso(params.to)}:${params.streamKey ?? ""}`;

  // Open-session poll (D6). State rather than a derivation of `base.data`,
  // because the interval is an OPTION of the query hook and has to be known
  // before the query renders; one render of lag is fine.
  const [anyOpen, setAnyOpen] = useState(false);
  const requested = options?.refetchIntervalMs;
  const refetchIntervalMs = anyOpen
    ? Math.min(requested ?? REPLAY_OPEN_POLL_MS, REPLAY_OPEN_POLL_MS)
    : requested;
  const effectiveOptions = useMemo<QueryOptions | undefined>(() => {
    if (refetchIntervalMs === requested) return options;
    return { ...options, refetchIntervalMs };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options, refetchIntervalMs, requested]);

  const base = useXorgateQuery<ReplayManifest>(
    key,
    (ctx) => {
      if (ctx.rest.kind !== "ready") {
        throw new XorgateError({ code: "INVALID_CONFIG", message: "No REST client available." });
      }
      return ctx.rest.client.media.replayManifest(deviceId!, params!);
    },
    effectiveOptions,
  );

  useEffect(() => {
    setAnyOpen(base.data ? manifestHasOpenSession(base.data) : false);
  }, [base.data]);

  const refreshUrls = useCallback(async () => {
    await base.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base.refetch]);
  const refreshRef = useRef(refreshUrls);
  refreshRef.current = refreshUrls;

  // Annotate the manifest with its refresh seam. Non-enumerable, so it never
  // serializes and never round-trips through JSON.
  const data = useMemo(() => {
    if (!base.data) return base.data;
    Object.defineProperty(base.data, MANIFEST_REFRESH, {
      value: () => refreshRef.current(),
      enumerable: false,
      configurable: true,
    });
    return base.data;
  }, [base.data]);

  // Self-refresh shortly before the presigned URLs lapse. `urlExpiresAt`
  // already carries a 5-minute safety margin; refreshing 60 s before it keeps
  // a second margin for a slow request.
  const urlsExpireAt = base.data?.urlExpiresAt ?? null;
  useEffect(() => {
    if (urlsExpireAt === null) return;
    const delay = Math.max(urlsExpireAt - Date.now() - 60_000, 5_000);
    const t = setTimeout(() => void refreshRef.current(), delay);
    return () => clearTimeout(t);
  }, [urlsExpireAt]);

  return { ...base, data, refreshUrls, urlsExpireAt };
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

/** True while any video or telemetry session in the manifest is still `open`. */
export function manifestHasOpenSession(manifest: ReplayManifest): boolean {
  if (manifest.sessions.some((s) => s.status === "open")) return true;
  return manifest.telemetry?.sessions.some((s) => s.status === "open") ?? false;
}
