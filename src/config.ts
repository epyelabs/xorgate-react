export type Awaitable<T> = T | Promise<T>;

/**
 * Everything the SDK needs to reach the platform, passed in rather than read
 * from the environment. Nothing under `@xorgate/react` reads an environment
 * variable; the provider's props are the whole configuration surface.
 *
 * Only first-party (Cognito) applications need the four AWS fields. In
 * `{ getSessionToken }` and `{ getLiveCredentials }` modes the live-plane
 * coordinates (`region`, `realtimeEndpoint`) arrive with the credential, so a
 * third party's whole config is `{}` or `{ baseUrl }`.
 */
export interface XorgateConfig {
  /**
   * A BARE ORIGIN, e.g. `https://api.xorgate.io`. The SDK appends the `/v1`
   * version segment itself. Defaults to `https://api.xorgate.io`, the
   * production deployment.
   */
  baseUrl?: string;
  /**
   * Live plane. Also the default for a video channel that reports no region of
   * its own. Arrives with the credential in the two third-party modes; supply
   * it only for the first-party mode or to override.
   */
  region?: string;
  /** Live plane, FIRST-PARTY ONLY. The identity pool that vends live credentials. */
  identityPoolId?: string;
  /** Live plane, FIRST-PARTY ONLY. Used to build the logins key for an ID token. */
  userPoolId?: string;
  /**
   * Live telemetry only: the host the realtime stream connects to, no scheme.
   * Arrives with the credential in the two third-party modes.
   */
  realtimeEndpoint?: string;
  /** Injected for tests. Defaults to global `fetch`. */
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Per-request deadline for REST calls. Default 30000. */
  timeoutMs?: number;
  /** Merged into every REST request. Cannot override auth or tenancy headers. */
  headers?: Record<string, string>;
}

/**
 * What the live plane signs its connections with.
 *
 * **Opaque.** Hand it back to the SDK and never read a field: the four SigV4
 * fields are dictated by the signing algorithm rather than chosen.
 *
 * A `POST /auth/live-credentials` response satisfies this type verbatim, and
 * passing it through UNREAD is exactly what a proxied consumer should do: the
 * response also carries `organizationId`, `workspaceId` and a `live` block with
 * the region and realtime endpoint, and the SDK reads those to scope the
 * telemetry subscription and configure itself, so the consumer's `config`
 * stays `{ baseUrl }`.
 */
export interface LiveCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** ISO string on the wire; a `Date` is accepted too. */
  expiration?: Date | string;
  /** Present on a `POST /auth/live-credentials` response. Pass it through. */
  organizationId?: string;
  /** Present on a `POST /auth/live-credentials` response. Pass it through. */
  workspaceId?: string | null;
  /** Present on a `POST /auth/live-credentials` response. Pass it through. */
  live?: { region: string; realtimeEndpoint: string };
}

/**
 * FIRST-PARTY mode: xorgate's own dashboard. REST via a Cognito **ID** token
 * (not an access token), live plane via identity-pool federation.
 *
 * `getIdToken` is called on every request and before every live (re)connect;
 * the SDK never caches it. Returning `null` means "not signed in yet": REST
 * hooks stay `isLoading`, live hooks stay `connecting`.
 */
export interface FirstPartyAuth {
  getIdToken: () => Awaitable<string | null>;
  getSessionToken?: never;
  apiKey?: never;
  getLiveCredentials?: never;
}

/**
 * THE THIRD-PARTY MODE, and the one to reach for by default.
 *
 * Your server exchanges its API key for a short-lived `xgs_` token and hands it
 * to your client; the client supplies it here. REST is authenticated with it
 * directly, the live-plane coordinates come back with the token, and the SDK
 * exchanges it for live credentials itself, so `config` collapses to
 * `{ baseUrl }` or nothing.
 *
 * Called on every request and before every live (re)connect; the SDK does not
 * cache it. Hold the token until shortly before `expiresAt`, then fetch another
 * from your own endpoint. Returning `null` means "not ready yet".
 */
export interface SessionTokenAuth {
  getSessionToken: () => Awaitable<string | null>;
  getIdToken?: never;
  apiKey?: never;
  getLiveCredentials?: never;
}

/**
 * REST only, sent as `Authorization: Bearer xg_…`.
 *
 * **A key in a browser bundle is a published key.** This mode exists for React
 * rendered on a server you control, or behind a proxy you own, and never for a
 * public SPA. The live plane reports `unavailableReason: "no-live-credentials"`
 * in this mode: vend on your server instead.
 */
export interface ApiKeyAuth {
  apiKey: string;
  getIdToken?: never;
  getSessionToken?: never;
  getLiveCredentials?: never;
}

/**
 * The PROXIED profile: a consumer whose own backend vends live credentials and
 * whose browser touches no xorgate REST endpoint at all. The backend holds the
 * `xg_` key, calls `POST /auth/live-credentials` with the workspace this end
 * user may see, and hands the response here verbatim.
 *
 * Nothing in `useLiveTelemetry`, `useLiveVideo` or `useReplayPlayer` mentions
 * an auth mode; they ask an internal resolver for credentials, which is what
 * lets this slot exist without touching a single hook contract.
 *
 * REST still needs its own slot if you want the data hooks, so `apiKey`,
 * `getIdToken` or `getSessionToken` may ride along. The SDK calls
 * `getLiveCredentials` on every connect and on the ~50 minute refresh cycle, so
 * an implementation should cache and only mint when its copy is near expiry.
 */
export interface LiveCredentialsAuth {
  getLiveCredentials: (options?: { signal?: AbortSignal }) => Promise<LiveCredentials>;
  apiKey?: string;
  getIdToken?: () => Awaitable<string | null>;
  getSessionToken?: () => Awaitable<string | null>;
}

export type XorgateAuth =
  | FirstPartyAuth
  | SessionTokenAuth
  | ApiKeyAuth
  | LiveCredentialsAuth;

/**
 * Why the live plane is off. Deliberately NOT an error: an app that cannot do
 * live video is a supported configuration, not a broken one.
 */
export type LiveUnavailableReason =
  /** The `auth` mode cannot produce live credentials (`{ apiKey }` alone). */
  | "no-live-credentials"
  /** `config` is missing `region`/`identityPoolId`/`userPoolId`/`realtimeEndpoint`. */
  | "not-configured"
  /** The device has no realtime identity or no video channels: never provisioned. */
  | "not-provisioned";
