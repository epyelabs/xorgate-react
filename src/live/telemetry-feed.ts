import { XorgateError } from "@xorgate/sdk";
import type { LatestByMetric, MetricName } from "@xorgate/sdk";
import type { LiveUnavailableReason } from "../config.js";
import type { LiveCredentialResolver, MqttConnectionSpec } from "./credential-resolver.js";
import { presignIotWssUrl } from "./iot-wss.js";
import {
  parseTelemetryPayload,
  type TelemetryMediaStatus,
  type TelemetryRecordingStatus,
} from "./payload.js";

export type LiveStatus = "connecting" | "connected" | "closed" | "error" | "unavailable";

/**
 * One live-telemetry sample, flattened for charting libraries: `ts` plus one
 * key per metric. `ts` is epoch MILLISECONDS in the DEVICE's clock domain.
 */
export interface TelemetryPoint {
  ts: number;
  [metric: `${string}.${string}`]: number | undefined;
}

export interface TelemetrySnapshot {
  /** The interop shape, identical to `useTelemetryLatest` and replay. */
  latest: LatestByMetric;
  /** Ring buffer, oldest first. */
  history: TelemetryPoint[];
  recording: TelemetryRecordingStatus | null;
  media: TelemetryMediaStatus | null;
  /** Browser-clock ms when the last valid payload arrived. */
  receivedAt: number | null;
  status: LiveStatus;
  unavailableReason: LiveUnavailableReason | null;
  error: XorgateError | null;
}

/** The slice of an mqtt.js client the feed uses; a fake stands in for tests. */
export interface MqttLikeClient {
  on(event: string, cb: (...args: unknown[]) => void): unknown;
  subscribe(topic: string, opts: { qos: 0 | 1 | 2 }): unknown;
  end(force?: boolean): unknown;
}

export interface TelemetryFeedDeps {
  resolver: LiveCredentialResolver;
  deviceId: string;
  /**
   * The MQTT connection factory: the platform's `mqttConnect`, or a dynamic
   * import of mqtt.js over the global WebSocket. Also the test seam.
   */
  connect?: (url: string, spec: MqttConnectionSpec) => Promise<MqttLikeClient>;
  /**
   * The platform's wake source (foreground, network back). A wake while the
   * socket is closed or a backoff is pending reconnects NOW.
   */
  subscribeWake?: (onWake: () => void) => () => void;
  /** Test seam for timers/clock. */
  now?: () => number;
}

const DEFAULT_HISTORY_CAP = 300; // ~5 min @ 1 Hz
const DEFAULT_FLUSH_MS = 250; // coalesce 1 Hz × N-metric updates into ≤4 renders/s
const REFRESH_MS = 50 * 60 * 1000; // re-presign well before the ~1 h URL/creds expiry

async function connectReal(url: string, spec: MqttConnectionSpec): Promise<MqttLikeClient> {
  const mod = await import("mqtt");
  const mqtt = (mod as unknown as { default?: typeof mod }).default ?? mod;
  return mqtt.connect(url, {
    protocolVersion: 5,
    reconnectPeriod: 0, // manual reconnect: the presigned URL is single-use-ish
    clientId: spec.clientId,
    // mqtt.js rebuilds the ws URL from host/path only and DROPS the query
    // string — which would strip the SigV4 params and get a 403 from IoT.
    transformWsUrl: () => url,
  }) as unknown as MqttLikeClient;
}

const decoder = new TextDecoder();

/**
 * One shared MQTT-over-WSS connection per device. Module-level and
 * ref-counted: `useLiveTelemetry` acquires on mount and releases on unmount,
 * and the connection closes when the last consumer leaves. Late mounters get
 * the current snapshot immediately.
 */
export class TelemetryFeed {
  refs = 0;

  private readonly deps: Required<Pick<TelemetryFeedDeps, "resolver" | "deviceId">> &
    TelemetryFeedDeps;
  private readonly subscribers = new Set<() => void>();

  private latest: LatestByMetric = {};
  private history: TelemetryPoint[] = [];
  private recording: TelemetryRecordingStatus | null = null;
  private media: TelemetryMediaStatus | null = null;
  private receivedAt: number | null = null;
  private status: LiveStatus = "connecting";
  private unavailableReason: LiveUnavailableReason | null = null;
  private error: XorgateError | null = null;

  private historyCap = DEFAULT_HISTORY_CAP;
  private flushMs = DEFAULT_FLUSH_MS;

  private stopped = false;
  private dirty = false;
  private client: MqttLikeClient | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private backoff = 1000;
  private snapshotCache: TelemetrySnapshot | null = null;
  private unsubscribeWake: (() => void) | null = null;
  // Generation counter: a nudge that re-opens must not let a stalled earlier
  // open() finish later and attach a second client.
  private openSeq = 0;

  constructor(deps: TelemetryFeedDeps) {
    this.deps = deps;
  }

  /** Consumers raise the shared caps; the feed keeps the most demanding ask. */
  tune(options: { historyLimit?: number; flushMs?: number }): void {
    if (options.historyLimit !== undefined) {
      this.historyCap = Math.max(this.historyCap, options.historyLimit);
    }
    if (options.flushMs !== undefined) {
      this.flushMs = Math.min(this.flushMs, options.flushMs);
      if (this.flushTimer) {
        clearInterval(this.flushTimer);
        this.startFlush();
      }
    }
  }

  snapshot(): TelemetrySnapshot {
    if (!this.snapshotCache) {
      this.snapshotCache = {
        latest: { ...this.latest },
        history: this.history.slice(-this.historyCap),
        recording: this.recording,
        media: this.media,
        receivedAt: this.receivedAt,
        status: this.status,
        unavailableReason: this.unavailableReason,
        error: this.error,
      };
    }
    return this.snapshotCache;
  }

  subscribe(cb: () => void): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  start(): void {
    const availability = this.deps.resolver.telemetryAvailability();
    if (!availability.available) {
      this.status = "unavailable";
      this.unavailableReason = availability.reason;
      this.invalidate();
      return;
    }
    this.startFlush();
    this.unsubscribeWake = this.deps.subscribeWake?.(() => this.nudge()) ?? null;
    void this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.unsubscribeWake?.();
    this.unsubscribeWake = null;
    this.client?.end(true);
  }

  /**
   * The app is back (foreground, network returned): if the socket is closed
   * or a backoff is pending, reconnect now instead of waiting it out. A feed
   * that is connected or mid-connect is left alone.
   */
  nudge(): void {
    if (this.stopped) return;
    if (this.status !== "closed" && this.status !== "error") return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.backoff = 1000;
    void this.open();
  }

  private startFlush(): void {
    this.flushTimer = setInterval(() => {
      if (!this.dirty) return;
      this.dirty = false;
      this.invalidate();
      this.notify();
    }, this.flushMs);
  }

  private invalidate(): void {
    this.snapshotCache = null;
  }

  private notify(): void {
    for (const cb of this.subscribers) cb();
  }

  private setStatus(status: LiveStatus, error: XorgateError | null = this.error): void {
    this.status = status;
    this.error = error;
    this.invalidate();
    this.notify();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.open();
    }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, 30_000);
  }

  private async open(): Promise<void> {
    if (this.stopped) return;
    const seq = ++this.openSeq;
    try {
      this.setStatus("connecting");
      // Mode-specific: in first-party mode this attaches the IoT policy to the
      // caller's identity (idempotent, before EVERY connect) and returns an
      // identity-prefixed client id plus both topic planes; in vended mode it
      // returns an `xgl-` client id and the single tenant-scoped topic.
      const spec = await this.deps.resolver.getMqttSpec(this.deps.deviceId);
      if (this.stopped || seq !== this.openSeq) return;
      const url = await presignIotWssUrl(spec.endpoint, spec.region, spec.credentials);
      if (this.stopped || seq !== this.openSeq) return;

      const connect = this.deps.connect ?? connectReal;
      const next = await connect(url, spec);
      if (this.stopped || seq !== this.openSeq) {
        next.end(true);
        return;
      }
      this.client?.end(true);
      this.client = next;

      next.on("connect", () => {
        if (this.stopped || this.client !== next) return;
        this.backoff = 1000;
        this.setStatus("connected", null);
        for (const t of spec.topics) next.subscribe(t, { qos: 0 });
      });

      next.on("message", (...args: unknown[]) => {
        const payload = args[1] as Uint8Array;
        let json: unknown;
        try {
          json = JSON.parse(decoder.decode(payload));
        } catch {
          return;
        }
        this.ingest(json);
      });

      next.on("error", (...args: unknown[]) => {
        if (this.stopped || this.client !== next) return;
        const err = args[0] as Error | undefined;
        this.setStatus(
          "error",
          new XorgateError({ code: "NETWORK", message: err?.message ?? "mqtt error" }),
        );
        next.end(true);
      });

      next.on("close", () => {
        if (this.stopped || this.client !== next) return;
        this.setStatus("closed");
        this.scheduleReconnect();
      });

      // Proactively cycle the connection before the presigned URL expires.
      if (this.refreshTimer) clearTimeout(this.refreshTimer);
      this.refreshTimer = setTimeout(() => next.end(true), REFRESH_MS);
    } catch (err) {
      if (this.stopped || seq !== this.openSeq) return;
      const isPending =
        err instanceof XorgateError && err.details?.pendingAuth === true;
      // "Not signed in yet" is not an error: stay `connecting` and retry.
      if (isPending) {
        this.setStatus("connecting");
      } else {
        this.setStatus(
          "error",
          err instanceof XorgateError
            ? err
            : new XorgateError({ code: "NETWORK", message: (err as Error).message }),
        );
      }
      this.scheduleReconnect();
    }
  }

  /** Exposed for tests: feed one wire frame through the parser. */
  ingest(json: unknown): void {
    const parsed = parseTelemetryPayload(json);
    if (!parsed) return;
    const point: TelemetryPoint = { ts: parsed.ts };
    const iso = new Date(parsed.ts).toISOString();
    for (const { metric, value, unit } of parsed.metrics) {
      // The SDK's interop shape: `metric` present, nullables, ISO `ts`.
      this.latest[metric as MetricName] = {
        metric: metric as MetricName,
        value,
        unit: unit ?? null,
        ts: iso,
      };
      point[metric as `${string}.${string}`] = value;
    }
    this.history.push(point);
    if (this.history.length > this.historyCap) {
      this.history.splice(0, this.history.length - this.historyCap);
    }
    // Keep the last seen blocks: a payload that omits them (or carries a
    // malformed one) must not flicker the UI back to null.
    if (parsed.recording) this.recording = parsed.recording;
    if (parsed.media) this.media = parsed.media;
    // Stamped on every accepted payload: freshness is a property of the FEED,
    // not of any block, and it is the BROWSER's clock on purpose.
    this.receivedAt = (this.deps.now ?? Date.now)();
    this.dirty = true;
  }
}

/**
 * Feed registry: one feed per (resolver, deviceId). Keyed by resolver so two
 * providers cannot cross-wire credentials, and by WeakMap so a discarded
 * provider's feeds are collectable.
 */
const registries = new WeakMap<LiveCredentialResolver, Map<string, TelemetryFeed>>();

export function acquireFeed(
  resolver: LiveCredentialResolver,
  deviceId: string,
  deps?: Partial<TelemetryFeedDeps>,
): TelemetryFeed {
  let feeds = registries.get(resolver);
  if (!feeds) {
    feeds = new Map();
    registries.set(resolver, feeds);
  }
  let feed = feeds.get(deviceId);
  if (!feed) {
    feed = new TelemetryFeed({ resolver, deviceId, ...deps });
    feeds.set(deviceId, feed);
    feed.start();
  }
  feed.refs++;
  return feed;
}

export function releaseFeed(
  resolver: LiveCredentialResolver,
  deviceId: string,
  feed: TelemetryFeed,
): void {
  feed.refs--;
  if (feed.refs > 0) return;
  registries.get(resolver)?.delete(deviceId);
  feed.stop();
}
