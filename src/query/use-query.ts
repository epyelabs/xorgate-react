import { useCallback, useEffect, useRef, useState } from "react";
import { XorgateError } from "@xorgate/sdk";
import { isPendingAuthError, useXorgateContext } from "../context.js";
import type { XorgateContextValue } from "../context.js";

/**
 * What every REST hook returns. Four fields are the contract; `isFetching` is
 * the fifth because a refetch spinner is a real requirement and overloading
 * `isLoading` for it makes every list flicker back to a skeleton.
 */
export interface QueryResult<T> {
  /** `undefined` until the first successful load. Stays put across a refetch. */
  data: T | undefined;
  error: XorgateError | null;
  /** True only while there is no data yet. A refetch does NOT flip it. */
  isLoading: boolean;
  /** True whenever a request is in flight, including a refetch and `loadMore`. */
  isFetching: boolean;
  /** Re-runs the query. Resolves when it settles; never rejects, `error` carries the failure. */
  refetch: () => Promise<void>;
}

export interface QueryOptions {
  /** Default true. False keeps the hook idle: no request, `data` undefined. */
  enabled?: boolean;
  /** Poll interval. Off by default. There are no webhooks, so this is how you stay current. */
  refetchIntervalMs?: number;
  /**
   * Refetch when the tab becomes visible again. Defaults to true when
   * `refetchIntervalMs` is set, false otherwise: a background tab's interval
   * is throttled to about once a minute, so the first frame after a return is
   * usually stale.
   */
  refetchOnFocus?: boolean;
}

/** How long to wait before probing a null auth token again. */
const PENDING_AUTH_RETRY_MS = 1000;

export type QueryScope = "organization" | "user";

/**
 * The subscribe-and-snapshot core every data hook shares. `run` receives the
 * context and must throw a XorgateError on failure; `key` identifies the query
 * so a param change resets `data` and aborts the stale run.
 */
export function useXorgateQuery<T>(
  key: string | null,
  run: (ctx: XorgateContextValue) => Promise<T>,
  options: QueryOptions = {},
  scope: QueryScope = "organization",
): QueryResult<T> {
  const ctx = useXorgateContext();
  const enabled = options.enabled !== false && key !== null;

  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<XorgateError | null>(null);
  const [isFetching, setIsFetching] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);

  // Generation guard: a param change or unmount invalidates in-flight runs.
  const generation = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const runRef = useRef(run);
  runRef.current = run;
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  const execute = useCallback(async (): Promise<void> => {
    const gen = generation.current;
    const context = ctxRef.current;

    // Resolve the plane state WITHOUT a request. `useMe()`/`useOrganizations()`
    // are user-scoped and keep working with a null organizationId.
    if (scope === "organization" && context.rest.kind === "no-organization") {
      const err = new XorgateError({
        code: "ORGANIZATION_REQUIRED",
        message:
          "This hook needs an active organization. Pass organizationId to " +
          "<XorgateProvider>.",
      });
      setError(err);
      setIsFetching(false);
      return;
    }
    if (context.rest.kind === "no-credential") {
      const err = new XorgateError({
        code: "INVALID_CONFIG",
        message:
          "This auth mode has no REST credential: `{ getLiveCredentials }` alone " +
          "reaches only the live and replay planes.",
      });
      setError(err);
      setIsFetching(false);
      return;
    }

    setIsFetching(true);
    try {
      const result = await runRef.current(context);
      if (gen !== generation.current) return;
      setData(result);
      setError(null);
      setHasLoaded(true);
      setIsFetching(false);
    } catch (err) {
      if (gen !== generation.current) return;
      // "Not signed in yet": stay isLoading and probe again shortly. The probe
      // costs one getter call and no network.
      if (isPendingAuthError(err)) {
        if (retryTimer.current) clearTimeout(retryTimer.current);
        retryTimer.current = setTimeout(() => {
          retryTimer.current = null;
          if (gen === generation.current) void execute();
        }, PENDING_AUTH_RETRY_MS);
        return;
      }
      const mapped =
        err instanceof XorgateError
          ? err
          : new XorgateError({ code: "NETWORK", message: (err as Error).message });
      setError(mapped);
      setIsFetching(false);
      context.reportError(mapped);
    }
  }, [scope]);

  // First load + reset on key/tenancy change.
  useEffect(() => {
    generation.current++;
    if (retryTimer.current) {
      clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
    setData(undefined);
    setError(null);
    setHasLoaded(false);
    setIsFetching(false);
    if (!enabled) return;
    void execute();
    return () => {
      generation.current++;
    };
    // `key` is the identity of the query; ctx identity covers tenancy + auth.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, ctx, execute]);

  // Poll interval.
  const interval = options.refetchIntervalMs;
  useEffect(() => {
    if (!enabled || !interval) return;
    const t = setInterval(() => void execute(), interval);
    return () => clearInterval(t);
  }, [enabled, interval, execute]);

  // Focus refetch, defaulting on with polling.
  const refetchOnFocus = options.refetchOnFocus ?? interval !== undefined;
  useEffect(() => {
    if (!enabled || !refetchOnFocus || typeof document === "undefined") return;
    const onVisible = () => {
      if (document.visibilityState === "visible") void execute();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [enabled, refetchOnFocus, execute]);

  const refetch = useCallback(async () => {
    if (!enabled) return;
    await execute();
  }, [enabled, execute]);

  return {
    data,
    error,
    isLoading: enabled && !hasLoaded && error === null,
    isFetching,
    refetch,
  };
}
