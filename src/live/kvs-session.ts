import { XorgateError } from "@xorgate/sdk";
import type { LiveCredentialResolver, ResolvedLiveCredentials } from "./credential-resolver.js";

/**
 * The KVS WebRTC VIEWER session, extracted from xorgate-web's use-kvs-viewer
 * with its platform boundary injected so the timer and generation machinery is
 * testable without real WebRTC. Every piece of hardening here was added in
 * response to a real failure against LTE devices; port deliberately, do not
 * simplify.
 */

export type LiveVideoStatus =
  | "connecting"
  | "waiting"
  | "connected"
  | "closed"
  | "error"
  | "unavailable";

export interface LiveVideoStats {
  width: number | null;
  height: number | null;
  fps: number | null;
  kbps: number | null;
}

/** The slice of RTCPeerConnection the session uses; fakes implement this. */
export interface PeerConnectionLike {
  connectionState: string;
  localDescription: unknown;
  addTransceiver(kind: string, init: { direction: string }): unknown;
  createOffer(options?: { offerToReceiveVideo?: boolean }): Promise<unknown>;
  setLocalDescription(desc: unknown): Promise<void>;
  setRemoteDescription(desc: unknown): Promise<void>;
  addIceCandidate(candidate: unknown): Promise<void>;
  addEventListener(type: string, cb: (event: never) => void): void;
  getStats(): Promise<Iterable<unknown> & { forEach(cb: (r: unknown) => void): void }>;
  close(): void;
}

/** The slice of the KVS signaling client the session uses. */
export interface SignalingLike {
  on(event: string, cb: (...args: never[]) => void): void;
  open(): void;
  close(): void;
  sendSdpOffer(offer: unknown): void;
  sendIceCandidate(candidate: unknown): void;
}

/** The platform boundary: real AWS wiring in production, a fake in tests. */
export interface WebRtcPlatform {
  getViewerEndpoints(
    channelRef: string,
    region: string,
    credentials: ResolvedLiveCredentials,
  ): Promise<{ wss: string; https: string; clockOffsetMs?: number }>;
  getIceServers(
    channelRef: string,
    region: string,
    httpsEndpoint: string,
    credentials: ResolvedLiveCredentials,
  ): Promise<unknown[]>;
  createSignaling(args: {
    channelRef: string;
    wssEndpoint: string;
    region: string;
    clientId: string;
    credentials: ResolvedLiveCredentials;
    clockOffsetMs?: number;
  }): SignalingLike;
  createPeerConnection(iceServers: unknown[]): PeerConnectionLike;
  randomId(): string;
}

/** Injectable timers, so backoff and deadlines run under a fake clock in tests. */
export interface TimerHost {
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
  setInterval(cb: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
}

export interface KvsSessionCallbacks {
  onStatus(status: LiveVideoStatus, error: XorgateError | null): void;
  onStats(stats: LiveVideoStats | null): void;
  /** Attach the received remote stream. Called on every track event. */
  onStream(stream: unknown): void;
}

export interface KvsSessionOptions {
  channelRef: string;
  region: string | undefined;
  resolver: Pick<LiveCredentialResolver, "getVideoSpec" | "invalidate">;
  platform: WebRtcPlatform;
  timers?: TimerHost;
  callbacks: KvsSessionCallbacks;
  /** inbound-rtp sampling period; also the bitrate averaging window. Default 2000. */
  statsIntervalMs?: number;
}

// Re-open with fresh creds before the ~1 h expiry.
const REFRESH_MS = 50 * 60 * 1000;
// A peer connection can dip to "disconnected" on a brief ICE blip, but the
// device master frees its side the instant ICE drops, so it will not
// self-heal: short grace, then force a fresh session.
const DISCONNECT_GRACE_MS = 2500;
// The signaling plane does not queue SDP offers: an offer sent while the
// master is offline gets no answer and no event, EVER. Deadline the attempt.
const CONNECT_TIMEOUT_MS = 15_000;
// On a flaky network the pre-signaling AWS calls hang without rejecting.
const SETUP_STEP_TIMEOUT_MS = 10_000;
const DEFAULT_STATS_INTERVAL_MS = 2000;
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30_000;

export class KvsViewerSession {
  private readonly opts: KvsSessionOptions;
  private readonly timers: TimerHost;

  private cancelled = false;
  private pc: PeerConnectionLike | null = null;
  private signaling: SignalingLike | null = null;
  private reconnectTimer: unknown = null;
  private refreshTimer: unknown = null;
  private disconnectTimer: unknown = null;
  private connectTimer: unknown = null;
  private statsTimer: unknown = null;
  private prevSample: { ts: number; bytesReceived: number; framesDecoded: number } | null = null;
  private backoff = BACKOFF_MIN_MS;
  // Generation counter: each open() invalidates prior in-flight runs, so a
  // stalled attempt resuming after an await cannot cross-wire a newer session.
  private openSeq = 0;

  constructor(opts: KvsSessionOptions) {
    this.opts = opts;
    this.timers = opts.timers ?? {
      setTimeout: (cb, ms) => setTimeout(cb, ms),
      clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
      setInterval: (cb, ms) => setInterval(cb, ms),
      clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>),
    };
  }

  start(): void {
    void this.open();
  }

  destroy(): void {
    this.cancelled = true;
    if (this.reconnectTimer) this.timers.clearTimeout(this.reconnectTimer);
    if (this.refreshTimer) this.timers.clearTimeout(this.refreshTimer);
    this.teardown();
  }

  /**
   * Mobile browsers freeze background tabs; the peer connection is usually
   * dead by the time the user returns. Skip any stale backoff and reconnect
   * now unless already connected.
   */
  nudge(): void {
    if (this.cancelled) return;
    if (this.pc && this.pc.connectionState === "connected") return;
    if (this.reconnectTimer) {
      this.timers.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.backoff = BACKOFF_MIN_MS;
    void this.open();
  }

  private status(status: LiveVideoStatus, error: XorgateError | null = null): void {
    if (this.cancelled) return;
    this.opts.callbacks.onStatus(status, error);
  }

  // Close the peer connection + signaling WITHOUT clearing the video element,
  // so a transient reconnect keeps the last frame on screen.
  private teardown(): void {
    if (this.statsTimer) {
      this.timers.clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    // The next session re-measures from scratch: a delta carried across a
    // reconnect would report a bogus bitrate for the gap.
    this.prevSample = null;
    this.opts.callbacks.onStats(null);
    if (this.disconnectTimer) {
      this.timers.clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
    }
    if (this.connectTimer) {
      this.timers.clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    if (this.signaling) {
      try {
        this.signaling.close();
      } catch {
        /* already closed */
      }
      this.signaling = null;
    }
    if (this.pc) {
      try {
        this.pc.close();
      } catch {
        /* already closed */
      }
      this.pc = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.cancelled || this.reconnectTimer) return;
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = null;
      void this.open();
    }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
  }

  private withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const t = this.timers.setTimeout(
        () => reject(new XorgateError({ code: "TIMEOUT", message: `${what} timed out` })),
        ms,
      );
      p.then(
        (v) => {
          this.timers.clearTimeout(t);
          resolve(v);
        },
        (e) => {
          this.timers.clearTimeout(t);
          reject(e);
        },
      );
    });
  }

  private async open(): Promise<void> {
    if (this.cancelled) return;
    const seq = ++this.openSeq;
    this.teardown(); // drop any prior connection before re-opening
    const { platform, resolver, callbacks } = this.opts;
    try {
      this.status("connecting");
      const spec = await this.withTimeout(
        resolver.getVideoSpec(),
        SETUP_STEP_TIMEOUT_MS,
        "credentials",
      );
      if (this.cancelled || seq !== this.openSeq) return;
      const region = this.opts.region ?? spec.region;
      if (!region) {
        throw new XorgateError({
          code: "INVALID_CONFIG",
          message:
            "No region for this video channel: the channel reported none and " +
            "config.region is unset.",
        });
      }

      const endpoints = await this.withTimeout(
        platform.getViewerEndpoints(this.opts.channelRef, region, spec.credentials),
        SETUP_STEP_TIMEOUT_MS,
        "signaling endpoints",
      );
      if (this.cancelled || seq !== this.openSeq) return;

      const iceServers = await this.withTimeout(
        platform.getIceServers(this.opts.channelRef, region, endpoints.https, spec.credentials),
        SETUP_STEP_TIMEOUT_MS,
        "ICE server config",
      );
      if (this.cancelled || seq !== this.openSeq) return;

      // Fresh clientId per connection: the signaling plane rejects a duplicate
      // VIEWER clientId, and a stale id from a half-closed session is refused.
      const signaling = platform.createSignaling({
        channelRef: this.opts.channelRef,
        wssEndpoint: endpoints.wss,
        region,
        clientId: platform.randomId(),
        credentials: spec.credentials,
        ...(endpoints.clockOffsetMs !== undefined
          ? { clockOffsetMs: endpoints.clockOffsetMs }
          : {}),
      });
      this.signaling = signaling;
      const pc = platform.createPeerConnection(iceServers);
      this.pc = pc;

      signaling.on("open", (async () => {
        if (this.cancelled || this.pc !== pc || this.signaling !== signaling) return;
        try {
          pc.addTransceiver("video", { direction: "recvonly" });
          const offer = await pc.createOffer({ offerToReceiveVideo: true });
          await pc.setLocalDescription(offer);
          if (this.cancelled || !pc.localDescription) return;
          signaling.sendSdpOffer(pc.localDescription);
          this.status("waiting");
        } catch (err) {
          if (this.cancelled) return;
          // Without a reschedule this was a dead end (stuck on "error" until a
          // page refresh); recover like every other failure path.
          this.status("error", toXorgateError(err));
          this.teardown();
          this.scheduleReconnect();
        }
      }) as () => void);

      signaling.on("sdpAnswer", (async (answer: unknown) => {
        if (this.cancelled || this.pc !== pc) return;
        try {
          await pc.setRemoteDescription(answer);
        } catch {
          /* late/duplicate answer */
        }
      }) as (answer: never) => void);

      signaling.on("iceCandidate", ((candidate: unknown) => {
        if (this.cancelled || this.pc !== pc) return;
        pc.addIceCandidate(candidate).catch(() => {
          /* candidate arrived before remote description */
        });
      }) as (candidate: never) => void);

      signaling.on("close", (() => {
        if (this.cancelled || this.signaling !== signaling) return;
        this.status("closed");
        this.scheduleReconnect();
      }) as () => void);

      signaling.on("error", ((err: unknown) => {
        if (this.cancelled || this.signaling !== signaling) return;
        this.status("error", toXorgateError(err));
        this.teardown();
        this.scheduleReconnect();
      }) as (err: never) => void);

      pc.addEventListener("icecandidate", ((event: { candidate: unknown }) => {
        if (this.cancelled || this.signaling !== signaling) return;
        if (event.candidate) signaling.sendIceCandidate(event.candidate);
      }) as never);

      pc.addEventListener("track", ((event: { streams: unknown[] }) => {
        if (this.cancelled) return;
        this.backoff = BACKOFF_MIN_MS;
        // Always (re)attach the incoming stream: on a reconnect the previous
        // srcObject points at a dead stream, and only attaching when empty
        // would leave the element frozen on the last frame.
        callbacks.onStream(event.streams[0]);
        this.status("connected");
      }) as never);

      pc.addEventListener("connectionstatechange", (() => {
        if (this.cancelled || this.pc !== pc) return;
        const state = pc.connectionState;
        if (state === "connected") {
          if (this.disconnectTimer) {
            this.timers.clearTimeout(this.disconnectTimer);
            this.disconnectTimer = null;
          }
          if (this.connectTimer) {
            this.timers.clearTimeout(this.connectTimer);
            this.connectTimer = null;
          }
        } else if (state === "failed") {
          this.status("closed");
          this.teardown();
          this.scheduleReconnect();
        } else if (state === "disconnected") {
          // Most common drop path (NAT/TURN/LTE blip). Wait a short grace for
          // a real micro-blip, then force a fresh session.
          if (!this.disconnectTimer) {
            this.disconnectTimer = this.timers.setTimeout(() => {
              this.disconnectTimer = null;
              if (this.cancelled || this.pc !== pc || pc.connectionState === "connected") return;
              this.status("closed");
              this.teardown();
              this.scheduleReconnect();
            }, DISCONNECT_GRACE_MS);
          }
        }
      }) as never);

      signaling.open();

      // Spec-label sampler. Before media flows there is no inbound-rtp report
      // and the sample no-ops.
      this.statsTimer = this.timers.setInterval(
        () => void this.sampleStats(),
        this.opts.statsIntervalMs ?? DEFAULT_STATS_INTERVAL_MS,
      );

      // Connect-attempt deadline: offer unanswered, ICE stalled or socket
      // half-open all end here, with a fresh session and a fresh offer.
      if (this.connectTimer) this.timers.clearTimeout(this.connectTimer);
      this.connectTimer = this.timers.setTimeout(() => {
        this.connectTimer = null;
        if (this.cancelled || this.pc?.connectionState === "connected") return;
        this.status("closed");
        this.teardown();
        this.scheduleReconnect();
      }, CONNECT_TIMEOUT_MS);

      // Proactively cycle the connection with fresh creds before they expire.
      if (this.refreshTimer) this.timers.clearTimeout(this.refreshTimer);
      this.refreshTimer = this.timers.setTimeout(() => {
        this.opts.resolver.invalidate();
        void this.open();
      }, REFRESH_MS);
    } catch (err) {
      // A stale run erroring out (e.g. its step timeout firing after a newer
      // open() took over) must not disturb the current attempt.
      if (this.cancelled || seq !== this.openSeq) return;
      this.status("error", toXorgateError(err));
      this.scheduleReconnect();
    }
  }

  // Sample inbound-rtp once. Resolution and fps come off the report; bitrate
  // is the bytesReceived delta since the previous sample, so the first sample
  // after a (re)connect has none.
  private async sampleStats(): Promise<void> {
    const pc = this.pc;
    if (this.cancelled || !pc) return;
    let reports: Awaited<ReturnType<PeerConnectionLike["getStats"]>>;
    try {
      reports = await pc.getStats();
    } catch {
      return; // connection went away mid-sample
    }
    if (this.cancelled) return;
    let inbound: Record<string, number | string | undefined> | null = null;
    reports.forEach((r) => {
      const s = r as Record<string, number | string | undefined>;
      if (s.type === "inbound-rtp" && s.kind === "video") inbound = s;
    });
    if (!inbound) return;
    const rtp = inbound as Record<string, number | undefined>;
    const ts = rtp.timestamp ?? 0;
    const bytesReceived = rtp.bytesReceived ?? 0;
    const framesDecoded = rtp.framesDecoded ?? 0;

    let kbps: number | null = null;
    let fps: number | null = rtp.framesPerSecond ?? null;
    if (this.prevSample && ts > this.prevSample.ts) {
      const secs = (ts - this.prevSample.ts) / 1000;
      const byteDelta = bytesReceived - this.prevSample.bytesReceived;
      if (byteDelta >= 0) kbps = (byteDelta * 8) / secs / 1000;
      if (fps === null) {
        const frameDelta = framesDecoded - this.prevSample.framesDecoded;
        if (frameDelta >= 0) fps = frameDelta / secs;
      }
    }
    this.prevSample = { ts, bytesReceived, framesDecoded };

    this.opts.callbacks.onStats({
      width: rtp.frameWidth ?? null,
      height: rtp.frameHeight ?? null,
      fps,
      kbps,
    });
  }
}

function toXorgateError(err: unknown): XorgateError {
  if (err instanceof XorgateError) return err;
  return new XorgateError({
    code: "NETWORK",
    message: (err as Error)?.message ?? String(err),
  });
}
