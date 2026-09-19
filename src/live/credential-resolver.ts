import { XorgateError } from "@xorgate/sdk";
import type {
  LiveCredentials,
  LiveUnavailableReason,
  XorgateAuth,
  XorgateConfig,
} from "../config.js";
import type { RestState } from "../context.js";
import { browserRandomId, type XorgatePlatform } from "../platform.js";

/** The four SigV4 fields, expiration parsed, ready to sign with. */
export interface ResolvedLiveCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** Epoch ms, or null when the source carried none. */
  expiresAtMs: number | null;
}

/** Everything one MQTT connect needs, resolved for the active auth mode. */
export interface MqttConnectionSpec {
  credentials: ResolvedLiveCredentials;
  region: string;
  /** Host, no scheme. */
  endpoint: string;
  /** Full client id for this connection. Fresh per call. */
  clientId: string;
  /** Topic filters to subscribe, in order. */
  topics: string[];
}

export interface VideoCredentialSpec {
  credentials: ResolvedLiveCredentials;
  /** Fallback region for a channel that reports none. */
  region: string | undefined;
}

/**
 * The tenancy the CURRENT live credential was vended for, as opposed to the
 * tenancy the provider was rendered with.
 *
 * `workspaceId` is null for an organization-scoped credential (it may reach
 * every workspace in its organization) and for a credential that has not been
 * vended yet. In first-party Cognito mode both fields fall back to the
 * provider's props, because there is no vend response to learn from.
 */
export interface LiveScope {
  organizationId: string | null;
  workspaceId: string | null;
}

interface ResolverDeps {
  getAuth: () => XorgateAuth;
  getConfig: () => XorgateConfig & { baseUrl: string };
  getRest: () => RestState;
  getTenancy: () => { organizationId: string | null; workspaceId: string | undefined };
  /** Optional so a test stub or an older caller can omit it: the browser default applies. */
  getPlatform?: () => XorgatePlatform;
}

/** Refresh a cached credential when it is this close to its expiry. */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;
/** Assumed lifetime for a credential that carries no expiration. */
const DEFAULT_LIFETIME_MS = 45 * 60 * 1000;

/**
 * MQTT client-id prefix a vended live credential MUST use: the ceiling role
 * scopes `iot:Connect` to `client/xgl-*`, and violating it surfaces as a bare
 * "Connection refused: Not authorized" with nothing pointing at the cause.
 */
export const LIVE_CLIENT_ID_PREFIX = "xgl-";

type Mode = "cognito" | "vended-direct" | "vended-token" | "none";

/**
 * The one place credentials for the live plane are resolved, so that no live
 * hook mentions an auth mode. Instances are created by the provider; hooks
 * reach it through context.
 *
 * Serialization safety: everything credential-bearing lives in non-enumerable
 * fields, and `toJSON()` reports only the mode. React DevTools serializes
 * context values, and an error reporter serializes whatever it was holding;
 * neither may see a secret.
 */
export class LiveCredentialResolver {
  constructor(deps: ResolverDeps) {
    defineHidden(this, "deps", deps);
    defineHidden(this, "cache", null);
    defineHidden(this, "inflight", null);
    // Scope learned from a vend response. Provider tenancy is only a fallback,
    // read live so a tenancy change is seen without recreating the resolver.
    // Named `vendScope` rather than `scope` because a hidden OWN property would
    // shadow the prototype's `scope()` method and make it uncallable.
    defineHidden(this, "vendScope", { organizationId: null, workspaceId: null });
  }

  toJSON(): { mode: Mode } {
    return { mode: this.mode() };
  }

  private get d(): ResolverDeps {
    return (this as unknown as { deps: ResolverDeps }).deps;
  }

  /** Client-id entropy from the platform slot, `crypto.randomUUID()` by default. */
  private randomId(): string {
    return (this.d.getPlatform?.().randomId ?? browserRandomId)();
  }

  mode(): Mode {
    const auth = this.d.getAuth();
    if (typeof auth.getLiveCredentials === "function") return "vended-direct";
    if (typeof auth.getSessionToken === "function") return "vended-token";
    if (typeof auth.getIdToken === "function") return "cognito";
    return "none";
  }

  /**
   * Whether the live plane is reachable with this provider's auth and config.
   * Per-device "not-provisioned" is reported by the hooks, not here.
   */
  availability(): { available: boolean; reason: LiveUnavailableReason | null } {
    const mode = this.mode();
    if (mode === "none") return { available: false, reason: "no-live-credentials" };
    if (mode === "cognito") {
      const cfg = this.d.getConfig();
      if (!cfg.region || !cfg.identityPoolId || !cfg.userPoolId) {
        return { available: false, reason: "not-configured" };
      }
    }
    return { available: true, reason: null };
  }

  /** Telemetry additionally needs the realtime endpoint in first-party mode. */
  telemetryAvailability(): { available: boolean; reason: LiveUnavailableReason | null } {
    const base = this.availability();
    if (!base.available) return base;
    if (this.mode() === "cognito" && !this.d.getConfig().realtimeEndpoint) {
      return { available: false, reason: "not-configured" };
    }
    return { available: true, reason: null };
  }

  /** Drop every cached credential. The provider calls this on teardown. */
  dispose(): void {
    setHidden(this, "cache", null);
    setHidden(this, "inflight", null);
    getHidden<Set<() => void> | undefined>(this, "listeners")?.clear();
  }

  /**
   * Force the next resolve to mint fresh credentials, keeping everything
   * learned about the tenancy.
   *
   * This is the EXPIRY path — the KVS session cycles credentials on a timer
   * with it — and it deliberately notifies nobody. Use
   * {@link invalidateScope} when the device's tenancy itself has changed.
   */
  invalidate(): void {
    setHidden(this, "cache", null);
  }

  /**
   * The device moved. Drop the credential AND everything learned from the last
   * vend, then tell every live consumer to re-resolve now.
   *
   * A vended live credential encodes org + workspace in its session policy and
   * is cached here until ~5 minutes before expiry, so without this a viewer
   * keeps a stale scope for up to about 50 minutes after a transfer. Telemetry
   * goes SILENT (the subscription names a topic the device no longer publishes
   * on) and video starts failing `AccessDenied` once the KVS channel is
   * re-tagged — neither of which looks like an error.
   *
   * Call it after transferring a device, or after accepting a transfer offer.
   * `useLiveScope().invalidate()` is the hook form.
   *
   * Note that this is invisible in `console.xorgate.io`, which subscribes to
   * BOTH telemetry planes with wildcards and therefore renders a device
   * whatever tenancy it publishes under. Only a workspace-scoped vended
   * credential — the third-party path — actually exercises it.
   */
  invalidateScope(): void {
    setHidden(this, "cache", null);
    setHidden(this, "vendScope", { organizationId: null, workspaceId: null });
    setHidden(this, "vendCoords", undefined);
    const listeners = getHidden<Set<() => void> | undefined>(this, "listeners");
    for (const cb of listeners ? [...listeners] : []) {
      try {
        cb();
      } catch {
        /* one consumer's failure must not stop the others being told */
      }
    }
  }

  /**
   * Be told when {@link invalidateScope} runs, so a live consumer can re-open
   * against the new tenancy instead of sitting on a socket that will never
   * receive anything again. Returns an unsubscribe function.
   */
  onInvalidate(cb: () => void): () => void {
    let listeners = getHidden<Set<() => void> | undefined>(this, "listeners");
    if (!listeners) {
      listeners = new Set();
      setHidden(this, "listeners", listeners);
    }
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  }

  /**
   * The tenancy the current credential was vended for, falling back to the
   * provider's props where nothing has been learned. Never carries a secret.
   */
  scope(): LiveScope {
    const learned = getHidden<{ organizationId: string | null; workspaceId: string | null }>(
      this,
      "vendScope",
    );
    const tenancy = this.d.getTenancy();
    return {
      organizationId: learned.organizationId ?? tenancy.organizationId ?? null,
      workspaceId: learned.workspaceId ?? tenancy.workspaceId ?? null,
    };
  }

  /**
   * Can this credential reach a device sitting in `workspaceId`?
   *
   * `null` means "cannot tell", and it is a real answer rather than a hedge.
   * Three things produce it, and none of them is a problem:
   *
   * - **First-party (Cognito) and unauthenticated modes.** Those credentials
   *   are not workspace-scoped at all — the first-party console subscribes to
   *   both telemetry planes with wildcards — so there is nothing to compare.
   *   The provider's `workspaceId` prop is a UI filter, not a credential scope,
   *   and comparing against it would invent false alarms.
   * - **Nothing vended yet.** Resolve credentials first.
   * - **An organization-scoped vended credential.** It may reach every
   *   workspace in its organization and this resolver does not know which those
   *   are, so a workspace id alone cannot settle it. (A CROSS-ORGANIZATION move
   *   is still caught, by the REST read answering 404.)
   *
   * Only `false` is evidence of a stale scope.
   */
  coversWorkspace(workspaceId: string): boolean | null {
    const mode = this.mode();
    if (mode !== "vended-direct" && mode !== "vended-token") return null;
    const learned = getHidden<{ workspaceId: string | null }>(this, "vendScope");
    if (learned.workspaceId === null) return null;
    return learned.workspaceId === workspaceId;
  }

  /**
   * Resolve credentials, cached until close to expiry and single-flighted so
   * six concurrent hooks cost one mint. Cognito-mode credentials are minted
   * per call by the identity pool provider, which caches internally.
   */
  async getCredentials(options: { signal?: AbortSignal } = {}): Promise<ResolvedLiveCredentials> {
    const cached = getHidden<ResolvedLiveCredentials | null>(this, "cache");
    if (cached && (cached.expiresAtMs === null || cached.expiresAtMs - Date.now() > EXPIRY_MARGIN_MS)) {
      return cached;
    }
    const inflight = getHidden<Promise<ResolvedLiveCredentials> | null>(this, "inflight");
    if (inflight) return inflight;

    const run = this.mint(options).then(
      (creds) => {
        setHidden(this, "cache", creds);
        setHidden(this, "inflight", null);
        return creds;
      },
      (err) => {
        setHidden(this, "inflight", null);
        throw err;
      },
    );
    setHidden(this, "inflight", run);
    return run;
  }

  private async mint(options: { signal?: AbortSignal }): Promise<ResolvedLiveCredentials> {
    const mode = this.mode();
    if (mode === "vended-direct") {
      const raw = await this.d.getAuth().getLiveCredentials!(options);
      this.adoptVendScope(raw);
      return normalize(raw);
    }
    if (mode === "vended-token") {
      const raw = await this.vendWithToken(options);
      this.adoptVendScope(raw);
      return normalize(raw);
    }
    if (mode === "cognito") {
      return this.mintCognito();
    }
    throw new XorgateError({
      code: "INVALID_CONFIG",
      message: "This auth mode cannot produce live credentials.",
    });
  }

  /** Org/workspace scope and live coordinates learned from a vend response. */
  private adoptVendScope(raw: LiveCredentials): void {
    const scope = getHidden<{ organizationId: string | null; workspaceId: string | null }>(this, "vendScope");
    if (typeof raw.organizationId === "string") scope.organizationId = raw.organizationId;
    if (raw.workspaceId !== undefined) scope.workspaceId = raw.workspaceId;
    if (raw.live) setHidden(this, "vendCoords", raw.live);
  }

  private liveCoords(): { region?: string; realtimeEndpoint?: string } {
    const learned = getHidden<{ region: string; realtimeEndpoint: string } | undefined>(this, "vendCoords");
    const cfg = this.d.getConfig();
    return {
      region: cfg.region ?? learned?.region,
      realtimeEndpoint: cfg.realtimeEndpoint ?? learned?.realtimeEndpoint,
    };
  }

  /**
   * `POST /auth/live-credentials` with the session token. A raw fetch rather
   * than the SDK client so it works while `organizationId` is null: the token
   * carries its own organization.
   */
  private async vendWithToken(options: { signal?: AbortSignal }): Promise<LiveCredentials> {
    const auth = this.d.getAuth();
    const token = await auth.getSessionToken!();
    if (token === null || token === undefined) {
      throw new XorgateError({
        code: "UNAUTHORIZED",
        message: "getSessionToken() returned null: no session yet.",
        details: { pendingAuth: true },
      });
    }
    const cfg = this.d.getConfig();
    const tenancy = this.d.getTenancy();
    const doFetch = cfg.fetch ?? fetch;
    const body: Record<string, unknown> = {};
    if (tenancy.workspaceId) body.workspaceId = tenancy.workspaceId;
    let res: Response;
    try {
      res = await doFetch(`${cfg.baseUrl}/v1/auth/live-credentials`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...(tenancy.organizationId ? { "X-Organization-Id": tenancy.organizationId } : {}),
        },
        body: JSON.stringify(body),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (err) {
      throw new XorgateError({
        code: "NETWORK",
        message: `Could not reach ${cfg.baseUrl}: ${(err as Error).message}`,
      });
    }
    const json = (await res.json().catch(() => null)) as
      | (LiveCredentials & { error?: { code?: string; message?: string } })
      | null;
    if (!res.ok || !json || typeof json.accessKeyId !== "string") {
      throw new XorgateError({
        code: (json?.error?.code as never) ?? "SERVER_ERROR",
        message: json?.error?.message ?? `Live-credential vend failed (HTTP ${res.status}).`,
        status: res.status,
      });
    }
    return json;
  }

  private async mintCognito(): Promise<ResolvedLiveCredentials> {
    const cfg = this.d.getConfig();
    if (!cfg.region || !cfg.identityPoolId || !cfg.userPoolId) {
      throw new XorgateError({
        code: "INVALID_CONFIG",
        message:
          "First-party live access needs region, identityPoolId and userPoolId in config.",
      });
    }
    const idToken = await this.d.getAuth().getIdToken!();
    if (idToken === null || idToken === undefined) {
      throw new XorgateError({
        code: "UNAUTHORIZED",
        message: "getIdToken() returned null: not signed in yet.",
        details: { pendingAuth: true },
      });
    }
    const { fromCognitoIdentityPool } = await import(
      "@aws-sdk/credential-provider-cognito-identity"
    );
    const provider = fromCognitoIdentityPool({
      identityPoolId: cfg.identityPoolId,
      logins: {
        [`cognito-idp.${cfg.region}.amazonaws.com/${cfg.userPoolId}`]: idToken,
      },
      clientConfig: { region: cfg.region },
    });
    const creds = await provider();
    return {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      ...(creds.sessionToken ? { sessionToken: creds.sessionToken } : {}),
      expiresAtMs: creds.expiration ? creds.expiration.getTime() : null,
    };
  }

  /**
   * Everything one telemetry connect needs. In first-party mode this also
   * attaches the browser IoT policy to the caller's own Cognito identity
   * (idempotent, done before EVERY connect on purpose) and scopes the client
   * id to the identity, both of which the broker enforces. In vended mode the
   * client id must start with `xgl-` and the subscription may reach ONLY the
   * scoped tenant topic; both rules otherwise surface as an anonymous
   * "Connection refused: Not authorized".
   */
  async getMqttSpec(deviceId: string, options: { signal?: AbortSignal } = {}): Promise<MqttConnectionSpec> {
    const mode = this.mode();
    if (mode === "none") {
      throw new XorgateError({
        code: "INVALID_CONFIG",
        message: "This auth mode cannot reach live telemetry.",
      });
    }

    if (mode === "cognito") {
      const cfg = this.d.getConfig();
      const { region, realtimeEndpoint } = this.liveCoords();
      if (!region || !realtimeEndpoint || !cfg.identityPoolId || !cfg.userPoolId) {
        throw new XorgateError({
          code: "INVALID_CONFIG",
          message:
            "First-party live telemetry needs region, identityPoolId, userPoolId and realtimeEndpoint in config.",
        });
      }
      const identityId = await this.attachPolicy();
      const credentials = await this.getCredentials(options);
      return {
        credentials,
        region,
        endpoint: realtimeEndpoint,
        clientId: `${identityId}-web-${this.randomId()}`,
        // BOTH telemetry planes: a device publishes to the unscoped topic
        // until the cloud tells it its tenant, and to the tenant-scoped one
        // after. The `+` wildcards stand in for the org and workspace, which
        // this consumer has no reason to know.
        topics: [
          `xorgate/devices/${deviceId}/telemetry`,
          `xorgate/orgs/+/ws/+/devices/${deviceId}/telemetry`,
        ],
      };
    }

    const credentials = await this.getCredentials(options);
    const { region, realtimeEndpoint } = this.liveCoords();
    if (!region || !realtimeEndpoint) {
      throw new XorgateError({
        code: "INVALID_CONFIG",
        message:
          "Live telemetry needs the region and realtime endpoint. They arrive on " +
          "the live-credentials response (`live` block) or the session token; " +
          "pass the vend response through unmodified, or set config.region and " +
          "config.realtimeEndpoint.",
      });
    }
    const scope = getHidden<{ organizationId: string | null; workspaceId: string | null }>(this, "vendScope");
    const tenancy = this.d.getTenancy();
    const organizationId = scope.organizationId ?? tenancy.organizationId;
    const workspaceId = scope.workspaceId ?? tenancy.workspaceId ?? null;
    if (!organizationId) {
      throw new XorgateError({
        code: "INVALID_CONFIG",
        message:
          "Live telemetry needs the organization id for the tenant-scoped topic. " +
          "Pass the live-credentials response through unmodified, or set the " +
          "provider's organizationId.",
      });
    }
    return {
      credentials,
      region,
      endpoint: realtimeEndpoint,
      clientId: `${LIVE_CLIENT_ID_PREFIX}${this.randomId()}`,
      // A workspace-scoped credential may subscribe ONLY to its own tenant
      // topic, spelled out concretely; an org-scoped one may wildcard the
      // workspace segment (`+` matches the policy's `*`).
      topics: [
        `xorgate/orgs/${organizationId}/ws/${workspaceId ?? "+"}/devices/${deviceId}/telemetry`,
      ],
    };
  }

  /** Live video needs only credentials; KVS authorizes with plain SigV4. */
  async getVideoSpec(options: { signal?: AbortSignal } = {}): Promise<VideoCredentialSpec> {
    if (this.mode() === "cognito") {
      const cfg = this.d.getConfig();
      if (!cfg.region || !cfg.identityPoolId || !cfg.userPoolId) {
        throw new XorgateError({
          code: "INVALID_CONFIG",
          message:
            "First-party live video needs region, identityPoolId and userPoolId in config.",
        });
      }
    }
    const credentials = await this.getCredentials(options);
    return { credentials, region: this.liveCoords().region };
  }

  /**
   * `POST /live/access`: attach the browser IoT policy to the CALLER's own
   * Cognito identity. First-party only; an endpoint that acts on the identity
   * of whoever calls it is meaningless from a server, which is why
   * `@xorgate/sdk` has no method for it and this package does.
   */
  private async attachPolicy(): Promise<string> {
    const rest = this.d.getRest();
    if (rest.kind !== "ready") {
      throw new XorgateError({
        code: rest.kind === "no-organization" ? "ORGANIZATION_REQUIRED" : "INVALID_CONFIG",
        message: "First-party live access needs a signed-in REST client with an active organization.",
      });
    }
    const res = await rest.client.request<{ attached: boolean; identityId: string }>(
      "POST",
      "/live/access",
    );
    if (!res || typeof res.identityId !== "string") {
      throw new XorgateError({
        code: "INVALID_RESPONSE",
        message: "POST /live/access returned no identityId.",
      });
    }
    return res.identityId;
  }
}

function defineHidden(target: object, name: string, value: unknown): void {
  Object.defineProperty(target, name, {
    value,
    writable: true,
    enumerable: false,
    configurable: true,
  });
}

function setHidden(target: object, name: string, value: unknown): void {
  if (Object.getOwnPropertyDescriptor(target, name)) {
    (target as Record<string, unknown>)[name] = value;
  } else {
    defineHidden(target, name, value);
  }
}

function getHidden<T>(target: object, name: string): T {
  return (target as Record<string, unknown>)[name] as T;
}

function normalize(raw: LiveCredentials): ResolvedLiveCredentials {
  if (!raw || typeof raw.accessKeyId !== "string" || typeof raw.secretAccessKey !== "string") {
    throw new XorgateError({
      code: "INVALID_RESPONSE",
      message:
        "getLiveCredentials() must resolve to a POST /auth/live-credentials response " +
        "(accessKeyId/secretAccessKey missing).",
    });
  }
  let expiresAtMs: number | null = null;
  if (raw.expiration instanceof Date) expiresAtMs = raw.expiration.getTime();
  else if (typeof raw.expiration === "string") {
    const t = Date.parse(raw.expiration);
    expiresAtMs = Number.isNaN(t) ? null : t;
  }
  return {
    accessKeyId: raw.accessKeyId,
    secretAccessKey: raw.secretAccessKey,
    ...(raw.sessionToken ? { sessionToken: raw.sessionToken } : {}),
    expiresAtMs,
  };
}
