import { useCallback, useEffect, useRef, useState } from "react";
import { XorgateError } from "@xorgate/sdk";
import { useXorgateContext } from "../context.js";
import type { LiveCredentials, LiveUnavailableReason } from "../config.js";

export interface UseLiveCredentials {
  credentials: LiveCredentials | null;
  unavailableReason: LiveUnavailableReason | null;
  error: XorgateError | null;
  refresh: () => Promise<void>;
}

/**
 * The credentials the live hooks use, resolved through whichever `auth` mode
 * is configured. Exposed so a consumer can drive an AWS SDK client of its own
 * with the same session, instead of building a parallel credential path.
 *
 * Returns null credentials while the live plane is unavailable. Cached and
 * refreshed the same way the hooks refresh.
 */
export function useLiveCredentials(): UseLiveCredentials {
  const { live } = useXorgateContext();
  const [state, setState] = useState<Omit<UseLiveCredentials, "refresh">>({
    credentials: null,
    unavailableReason: null,
    error: null,
  });
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(
    async (force: boolean) => {
      const availability = live.availability();
      if (!availability.available) {
        if (alive.current) {
          setState({ credentials: null, unavailableReason: availability.reason, error: null });
        }
        return;
      }
      try {
        if (force) live.invalidate();
        const creds = await live.getCredentials();
        if (!alive.current) return;
        setState({
          credentials: {
            accessKeyId: creds.accessKeyId,
            secretAccessKey: creds.secretAccessKey,
            ...(creds.sessionToken ? { sessionToken: creds.sessionToken } : {}),
            ...(creds.expiresAtMs !== null ? { expiration: new Date(creds.expiresAtMs) } : {}),
          },
          unavailableReason: null,
          error: null,
        });
      } catch (err) {
        if (!alive.current) return;
        setState({
          credentials: null,
          unavailableReason: null,
          error:
            err instanceof XorgateError
              ? err
              : new XorgateError({ code: "NETWORK", message: (err as Error).message }),
        });
      }
    },
    [live],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  const refresh = useCallback(() => load(true), [load]);

  return { ...state, refresh };
}
