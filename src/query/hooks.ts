import { useCallback, useMemo, useRef, useState } from "react";
import { XorgateError } from "@xorgate/sdk";
import type {
  Device,
  DeviceModel,
  LatestByMetric,
  ListDevicesParams,
  ListRunsParams,
  ListSessionsParams,
  Me,
  MediaSession,
  Organization,
  Page,
  PageMeta,
  RecordingRun,
  TelemetryHistory,
  TelemetryHistoryParams,
  VideoChannel,
  Workspace,
  XorgateClient,
} from "@xorgate/sdk";
import { useXorgateContext } from "../context.js";
import type { XorgateContextValue } from "../context.js";
import { useXorgateQuery, type QueryOptions, type QueryResult } from "./use-query.js";

function requireClient(ctx: XorgateContextValue): XorgateClient {
  // useXorgateQuery resolves the no-org / no-credential states before calling
  // the runner, so reaching here without a client is a bug, not a user state.
  if (ctx.rest.kind !== "ready") {
    throw new XorgateError({
      code: "INVALID_CONFIG",
      message: "No REST client available.",
    });
  }
  return ctx.rest.client;
}

export function useMe(options?: QueryOptions): QueryResult<Me> {
  return useXorgateQuery(
    "me",
    (ctx) => {
      if (ctx.rest.kind === "ready") return ctx.rest.client.me();
      if (!ctx.bootstrap) {
        throw new XorgateError({
          code: "INVALID_CONFIG",
          message: "This auth mode has no REST credential.",
        });
      }
      return ctx.bootstrap.me();
    },
    options,
    "user",
  );
}

/** Works with a null `organizationId`: this is how an org switcher is populated. */
export function useOrganizations(options?: QueryOptions): QueryResult<Organization[]> {
  return useXorgateQuery(
    "organizations",
    async (ctx) => {
      if (ctx.bootstrap) return ctx.bootstrap.listOrganizations();
      throw new XorgateError({
        code: "INVALID_CONFIG",
        message: "This auth mode has no REST credential.",
      });
    },
    options,
    "user",
  );
}

export function useWorkspaces(options?: QueryOptions): QueryResult<Workspace[]> {
  return useXorgateQuery("workspaces", (ctx) => requireClient(ctx).workspaces.list(), options);
}

/** Pass `null` to stay idle: this is how you obey the Rules of Hooks on a detail route. */
export function useDevice(
  deviceId: string | null,
  options?: QueryOptions,
): QueryResult<Device> {
  return useXorgateQuery(
    deviceId === null ? null : `device:${deviceId}`,
    (ctx) => requireClient(ctx).devices.get(deviceId!),
    options,
  );
}

export function useDeviceModel(
  deviceModelId: string | null,
  options?: QueryOptions,
): QueryResult<DeviceModel> {
  return useXorgateQuery(
    deviceModelId === null ? null : `device-model:${deviceModelId}`,
    (ctx) => requireClient(ctx).deviceModels.get(deviceModelId!),
    options,
  );
}

/**
 * The keyed shape, not the array the endpoint returns, because that is the
 * interop contract every other telemetry source on this platform emits.
 *
 * Stale on an offline device: the endpoint returns the last reading ingested
 * forever, with no staleness signal. Compare `reading.ts` against now yourself.
 */
export function useTelemetryLatest(
  deviceId: string | null,
  options?: QueryOptions,
): QueryResult<LatestByMetric> {
  return useXorgateQuery(
    deviceId === null ? null : `telemetry-latest:${deviceId}`,
    (ctx) => requireClient(ctx).telemetry.latestByMetric(deviceId!),
    options,
  );
}

export type UseTelemetryHistoryParams = Omit<TelemetryHistoryParams, "signal">;

/**
 * Check `data.truncated` on every render that uses this. It is the ONLY signal
 * that rows were left behind: the endpoint does not paginate, so a truncated
 * response is a chart that silently stops early.
 */
export function useTelemetryHistory(
  deviceId: string | null,
  params: UseTelemetryHistoryParams,
  options?: QueryOptions,
): QueryResult<TelemetryHistory> {
  const key =
    deviceId === null
      ? null
      : `telemetry-history:${deviceId}:${iso(params.from)}:${iso(params.to)}:${(params.metric ?? []).join(",")}:${params.interval ?? ""}`;
  return useXorgateQuery(
    key,
    (ctx) => requireClient(ctx).telemetry.history(deviceId!, params),
    options,
  );
}

/** Metadata only, no credentials. An empty array means the device is not provisioned. */
export function useVideoChannels(
  deviceId: string | null,
  options?: QueryOptions,
): QueryResult<VideoChannel[]> {
  return useXorgateQuery(
    deviceId === null ? null : `video-channels:${deviceId}`,
    (ctx) => requireClient(ctx).devices.videoChannels(deviceId!),
    options,
  );
}

function iso(value: string | Date | undefined): string {
  if (value === undefined) return "";
  return value instanceof Date ? value.toISOString() : value;
}

// ---------------------------------------------------------------------------
// Paginated hooks
// ---------------------------------------------------------------------------

interface PaginatedResult<T> extends QueryResult<T[]> {
  /** The echoed page block, including the CLAMPED `limit`. Undefined before the first load. */
  page: PageMeta | undefined;
  /** `page.offset + data.length < page.total`. */
  hasMore: boolean;
  isLoadingMore: boolean;
  /** APPENDS the next page to `data`. A no-op when `hasMore` is false. */
  loadMore: () => Promise<void>;
}

/**
 * `data` is a flat `T[]`, NOT the backend SDK's `Page<T>`. In React the
 * cannot-miss-pagination hazard is answered by an affordance rather than a
 * wrapper: `hasMore` and `loadMore` are visible in the destructure, and `page`
 * is right there beside `data`.
 */
function usePaginated<T>(
  key: string | null,
  fetchPage: (ctx: XorgateContextValue, offset: number | undefined) => Promise<Page<T>>,
  options: QueryOptions,
): PaginatedResult<T> {
  const ctx = useXorgateContext();
  const [pages, setPages] = useState<{ key: string | null; items: T[]; page: PageMeta } | null>(
    null,
  );
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;

  const base = useXorgateQuery<Page<T>>(
    key,
    (context) => fetchRef.current(context, undefined),
    options,
  );

  // The base query holds page 1; loadMore appends into `pages`, keyed so a
  // param change discards the accumulation.
  const first = base.data;
  const accumulated = pages !== null && pages.key === key ? pages : null;
  const items = useMemo(() => {
    if (!first) return undefined;
    return accumulated ? accumulated.items : first.items;
  }, [first, accumulated]);
  const pageMeta = accumulated?.page ?? first?.page;

  const hasMore =
    pageMeta !== undefined && items !== undefined
      ? pageMeta.offset + items.length < pageMeta.total
      : false;

  const loadMore = useCallback(async () => {
    if (!hasMore || items === undefined || isLoadingMore) return;
    setIsLoadingMore(true);
    try {
      const next = await fetchRef.current(ctx, (pageMeta?.offset ?? 0) + items.length);
      setPages({
        key,
        items: [...items, ...next.items],
        page: { ...next.page, offset: pageMeta?.offset ?? 0 },
      });
    } catch (err) {
      const mapped =
        err instanceof XorgateError
          ? err
          : new XorgateError({ code: "NETWORK", message: (err as Error).message });
      ctx.reportError(mapped);
      throw mapped;
    } finally {
      setIsLoadingMore(false);
    }
  }, [hasMore, items, isLoadingMore, ctx, pageMeta, key]);

  return {
    data: items,
    error: base.error,
    isLoading: base.isLoading,
    isFetching: base.isFetching || isLoadingMore,
    refetch: useCallback(async () => {
      setPages(null);
      await base.refetch();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [base.refetch]),
    page: pageMeta,
    hasMore,
    isLoadingMore,
    loadMore,
  };
}

/** `signal` is dropped: a hook owns its own abort, tied to unmount and to re-runs. */
export type UseDevicesParams = Omit<ListDevicesParams, "signal"> & QueryOptions;

export interface UseDevicesResult extends PaginatedResult<Device> {}

/**
 * An out-of-organization `workspaceId` yields an EMPTY page, not an error, so
 * an empty `data` never distinguishes "no devices" from "wrong workspace".
 */
export function useDevices(params: UseDevicesParams = {}): UseDevicesResult {
  const { enabled, refetchIntervalMs, refetchOnFocus, ...listParams } = params;
  const key = `devices:${JSON.stringify(listParams)}`;
  return usePaginated<Device>(
    key,
    (ctx, offset) =>
      requireClient(ctx).devices.list(
        offset === undefined ? listParams : { ...listParams, offset },
      ),
    { enabled, refetchIntervalMs, refetchOnFocus },
  );
}

export interface UseSessionsParams extends QueryOptions {
  streamKey?: string;
  from?: string | Date;
  to?: string | Date;
  limit?: number;
  offset?: number;
}

export interface UseRunsResult extends PaginatedResult<RecordingRun> {}
export interface UseSessionsResult extends PaginatedResult<MediaSession> {}

/**
 * Recording RUNS, not sessions: one drive with two cameras is two sessions and
 * one run. Clustering happens server-side, so pages are even and no run
 * straddles a boundary. Use `run.fromTs`/`run.toTs` as the replay window.
 */
export function useRecordingRuns(
  deviceId: string | null,
  params: UseSessionsParams = {},
): UseRunsResult {
  const { enabled, refetchIntervalMs, refetchOnFocus, ...listParams } = params;
  const key =
    deviceId === null ? null : `runs:${deviceId}:${JSON.stringify(sanitize(listParams))}`;
  return usePaginated<RecordingRun>(
    key,
    (ctx, offset) =>
      requireClient(ctx).media.sessions.listRuns(deviceId!, {
        ...(listParams as ListRunsParams),
        ...(offset !== undefined ? { offset } : {}),
      }),
    { enabled, refetchIntervalMs, refetchOnFocus },
  );
}

/** The flat session list. Prefer `useRecordingRuns` for anything user-facing. */
export function useSessions(
  deviceId: string | null,
  params: UseSessionsParams = {},
): UseSessionsResult {
  const { enabled, refetchIntervalMs, refetchOnFocus, ...listParams } = params;
  const key =
    deviceId === null ? null : `sessions:${deviceId}:${JSON.stringify(sanitize(listParams))}`;
  return usePaginated<MediaSession>(
    key,
    (ctx, offset) =>
      requireClient(ctx).media.sessions.list(deviceId!, {
        ...(listParams as ListSessionsParams),
        ...(offset !== undefined ? { offset } : {}),
      }),
    { enabled, refetchIntervalMs, refetchOnFocus },
  );
}

function sanitize(params: { from?: string | Date; to?: string | Date }): unknown {
  return { ...params, from: iso(params.from), to: iso(params.to) };
}
