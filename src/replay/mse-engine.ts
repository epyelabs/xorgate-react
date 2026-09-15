import type { ReplaySegment } from "@xorgate/sdk";
import { parseSegmentMediaInfo } from "./mp4-box.js";
import type { ReplayEngine, ReplayEngineOptions } from "./replay-engine.js";
import { nextSegmentAfter, segmentAt, segmentEnd, type ReplayTimeline } from "./timeline.js";

// How far behind the playhead we keep buffered media when Chrome's quota
// forces an eviction (~120 s keeps small back-scrubs warm).
const EVICT_KEEP_BEHIND_S = 120;
const FETCH_RETRY_MS = 4000;

interface AppendTask {
  seq: number;
  data: ArrayBuffer;
  offsetSec: number;
  partial: boolean;
  attempts: number;
}

/**
 * Imperative MSE side of a replay lane: one `SourceBuffer`, duration pinned to
 * the replay span before the first append (without which seeks beyond
 * appended data clamp and hang), per-segment `timestampOffset` derived from
 * the parsed tfdt rather than trusting the file to start at zero, one segment
 * of prefetch, quota-evict + retry on `QuotaExceededError`, and
 * `video.buffered` as the truth because WebKit evicts silently.
 *
 * The browser's `ReplayEngine`: the media surface the player core drives
 * (position, play/pause, rate, buffered ranges, stalls) is the `<video>`
 * element itself.
 */
export class MseEngine implements ReplayEngine {
  private readonly video: HTMLVideoElement;
  private readonly timeline: ReplayTimeline;
  private readonly getUrl: (seg: ReplaySegment) => string;
  private readonly onError: (message: string) => void;
  private readonly onUpdate: () => void;
  private readonly onAuthError: (() => void) | undefined;

  private ms: MediaSource | null = null;
  private sb: SourceBuffer | null = null;
  private objectUrl: string | null = null;
  private initStarted = false;
  private destroyed = false;
  private pendingOp: "append" | "remove" | null = null;
  private readonly queue: AppendTask[] = [];
  // Keyed by segment startTs, not seq: a composite lane merges same-streamKey
  // sessions, and seq restarts at 0 in each (startTs is unique within a lane).
  private readonly fetching = new Set<number>();
  private readonly lastAttempt = new Map<number, number>();
  private readonly abort = new AbortController();

  constructor(opts: ReplayEngineOptions & { video: HTMLVideoElement }) {
    this.video = opts.video;
    this.timeline = opts.timeline;
    this.getUrl = opts.getUrl;
    this.onError = opts.onError;
    this.onUpdate = opts.onUpdate;
    this.onAuthError = opts.onAuthError;
  }

  // --- the media surface (ReplayEngine) ------------------------------------

  get position(): number {
    return this.video.currentTime;
  }

  get paused(): boolean {
    return this.video.paused;
  }

  buffered(): Array<{ start: number; end: number }> {
    const { buffered } = this.video;
    const out: Array<{ start: number; end: number }> = [];
    for (let i = 0; i < buffered.length; i++) {
      out.push({ start: buffered.start(i), end: buffered.end(i) });
    }
    return out;
  }

  seek(posSec: number): void {
    this.video.currentTime = posSec;
  }

  play(): void {
    void this.video.play().catch(() => {
      /* interrupted by pause/seek — the next notify reconciles */
    });
  }

  pause(): void {
    this.video.pause();
  }

  setRate(rate: number): void {
    if (this.video.playbackRate !== rate) this.video.playbackRate = rate;
  }

  /** HAVE_CURRENT_DATA or less: the element cannot advance. */
  isStalled(): boolean {
    return this.video.readyState <= 2;
  }

  on(event: "waiting" | "firstFrame", cb: () => void): () => void {
    const name = event === "waiting" ? "waiting" : "loadeddata";
    this.video.addEventListener(name, cb);
    return () => this.video.removeEventListener(name, cb);
  }

  destroy(): void {
    this.destroyed = true;
    this.abort.abort();
    this.queue.length = 0;
    try {
      if (this.ms && this.ms.readyState === "open") this.ms.endOfStream();
    } catch {
      /* already closed */
    }
    this.video.removeAttribute("src");
    this.video.load();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
  }

  private segPos(seg: ReplaySegment): number {
    return (seg.startTs - this.timeline.from) / 1000;
  }

  // Buffered-as-truth: WebKit silently auto-evicts, so an appended-seq set
  // alone would lie — always consult video.buffered.
  isBufferedAt(posSec: number): boolean {
    const { buffered } = this.video;
    for (let i = 0; i < buffered.length; i++) {
      if (posSec >= buffered.start(i) - 0.1 && posSec < buffered.end(i)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Make sure the segment covering ts (if any) and the next one are fetched
   * and buffered. Called at clock-notify rate — every path below is guarded so
   * steady state does no work.
   */
  ensureAt(ts: number): void {
    if (this.destroyed) return;
    const hit = segmentAt(this.timeline, ts);
    if (hit) {
      // Probe a little ahead of the playhead, clamped inside the segment so
      // the exclusive tail does not trigger eternal refetches.
      const probe = Math.min(
        (ts - this.timeline.from) / 1000 + 0.3,
        this.segPos(hit.segment) + hit.segment.effectiveDurationMs / 1000 - 0.5,
      );
      if (!this.isBufferedAt(Math.max(probe, this.segPos(hit.segment)))) {
        this.fetchSegment(hit.segment);
      }
    }
    // Prefetch one segment ahead: never starved at 1x or 4x, and makes gap
    // exits and seeks feel instant.
    const next = nextSegmentAfter(this.timeline, hit ? segmentEnd(hit.segment) : ts);
    if (next && !this.isBufferedAt(this.segPos(next) + 0.5)) {
      this.fetchSegment(next);
    }
  }

  private fetchSegment(seg: ReplaySegment): void {
    if (this.fetching.has(seg.startTs)) return;
    const last = this.lastAttempt.get(seg.startTs);
    if (last !== undefined && performance.now() - last < FETCH_RETRY_MS) return;
    this.lastAttempt.set(seg.startTs, performance.now());
    this.fetching.add(seg.startTs);
    void (async () => {
      try {
        const res = await fetch(this.getUrl(seg), { signal: this.abort.signal });
        if (!res.ok) {
          // Presigned URL expired/revoked: tell the page so it can refresh
          // the manifest early (the backoff retry then uses the fresh URL).
          if (res.status === 403) this.onAuthError?.();
          throw new Error(`segment ${seg.seq}: HTTP ${res.status}`);
        }
        const data = await res.arrayBuffer();
        if (this.destroyed) return;
        const info = parseSegmentMediaInfo(data);
        if (!this.initStarted) this.initMse(info.codec);
        this.queue.push({
          seq: seg.seq,
          data,
          // Every segment's internal timeline restarts at ~0; the offset is
          // effectively segPos, but subtracting the parsed tfdt guards
          // against future muxer changes.
          offsetSec: this.segPos(seg) - info.firstTfdtSec,
          partial: !seg.finalized,
          attempts: 0,
        });
        this.processQueue();
      } catch (err) {
        if (this.destroyed || (err as Error).name === "AbortError") return;
        // Transient (expired URL just before a manifest refresh, network
        // blip): ensureAt retries after the backoff window.
        console.warn("replay segment fetch failed", err);
      } finally {
        this.fetching.delete(seg.startTs);
      }
    })();
  }

  private initMse(codec: string | null): void {
    this.initStarted = true;
    const type = `video/mp4; codecs="${codec ?? "avc1.42C028"}"`;
    if (!("MediaSource" in globalThis) || !MediaSource.isTypeSupported(type)) {
      this.onError(`This browser cannot play the recorded video (${type} unsupported).`);
      return;
    }
    const ms = new MediaSource();
    this.ms = ms;
    ms.addEventListener("sourceopen", () => {
      if (this.destroyed || this.sb) return;
      const sb = ms.addSourceBuffer(type);
      sb.mode = "segments";
      // Pin duration to the replay span BEFORE any append: without this,
      // seeks beyond appended data clamp and hang.
      ms.duration = (this.timeline.to - this.timeline.from) / 1000;
      sb.addEventListener("updateend", () => this.onUpdateEnd());
      sb.addEventListener("error", () => {
        this.onError("Video buffer error — try reloading the page.");
      });
      this.sb = sb;
      this.processQueue();
    });
    this.objectUrl = URL.createObjectURL(ms);
    this.video.src = this.objectUrl;
  }

  private onUpdateEnd(): void {
    if (this.destroyed) return;
    const op = this.pendingOp;
    this.pendingOp = null;
    if (op === "append") {
      const task = this.queue.shift();
      // Crash-cut file appended: reset the box parser before the next append.
      if (task?.partial && this.sb && !this.sb.updating) {
        try {
          this.sb.abort();
        } catch {
          /* parser reset is best-effort */
        }
      }
      this.onUpdate();
    }
    this.processQueue();
  }

  private processQueue(): void {
    const sb = this.sb;
    if (!sb || sb.updating || this.pendingOp || this.queue.length === 0) return;
    const task = this.queue[0];
    try {
      sb.timestampOffset = task.offsetSec;
      this.pendingOp = "append";
      sb.appendBuffer(task.data);
    } catch (err) {
      this.pendingOp = null;
      if ((err as Error).name === "QuotaExceededError" && task.attempts < 3) {
        // Drop far-behind media, then retry the append. Chrome throws this;
        // WebKit never does.
        task.attempts++;
        const playheadPos = this.video.currentTime;
        const evictEnd = Math.max(playheadPos - EVICT_KEEP_BEHIND_S, 1);
        try {
          this.pendingOp = "remove";
          sb.remove(0, evictEnd);
        } catch {
          this.pendingOp = null;
          this.queue.shift();
          this.onError("Video buffer full and eviction failed.");
        }
      } else {
        this.queue.shift();
        console.warn("replay append failed", err);
        this.processQueue();
      }
    }
  }
}
