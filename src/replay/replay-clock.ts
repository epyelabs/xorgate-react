import { clampTs, gapAt, type ReplayTimeline } from "./timeline.js";

// The master replay clock: ONE wall-clock playhead (epoch ms) that everything
// on the page follows. Nothing reads video.currentTime directly — video tiles
// register as pacer candidates and the clock elects who rules:
//
// - Playing with video coverage at the playhead: ONE elected lane's video
//   element PACES the clock, so A/V-vs-telemetry drift is structurally
//   impossible. Election is sticky — the incumbent keeps pacing while its
//   lane covers the playhead, then the first registered lane with coverage
//   takes over. Other lanes are followers: they chase the clock and re-seek
//   when drift exceeds ~150 ms (tile side). A stalled pacer freezes the
//   clock — correct: telemetry and the other lanes wait with it.
// - Playing with no lane covering: free-run at rate × real time, or jump
//   manifest gaps when skipGaps is on.
// - Seek/scrub: the user sets the clock; followers re-derive. Discontinuities
//   bump seekSeq so the video tiles know to re-align (a pace tick never does).
//
// Pure logic — the rAF driver lives in the React hook, so this unit-tests
// with synthetic ticks.

export const REPLAY_RATES = [0.5, 1, 2, 4] as const;
export type ReplayRate = (typeof REPLAY_RATES)[number];

export interface PacerCandidate {
  /** Wall-clock ts (epoch ms) the candidate's media element currently shows. */
  read: () => number;
  /** Whether the candidate's lane has video coverage at ts. */
  covers: (ts: number) => boolean;
}

export interface GapSkipEvent {
  fromTs: number;
  toTs: number;
  /** Monotonic, so a transient "skipped 40s" notice needs no timestamp comparison. */
  seq: number;
}

export interface ReplayClockState {
  /** Epoch ms. The single playhead everything on the page follows. */
  playheadTs: number;
  playing: boolean;
  rate: ReplayRate;
  skipGaps: boolean;
  /** Bumped on every discontinuity the pacer did not cause. A pace tick never bumps it. */
  seekSeq: number;
  lastSkip: GapSkipEvent | null;
}

export class ReplayClock {
  readonly timeline: ReplayTimeline;

  private playheadTs: number;
  private playing = false;
  private rate: ReplayRate = 1;
  private skipGaps = true;
  private seekSeq = 0;
  private lastSkip: GapSkipEvent | null = null;
  private skipCounter = 0;

  // Pacer candidates in registration order (Map preserves insertion order).
  private readonly pacers = new Map<string, PacerCandidate>();
  private electedPacer: string | null = null;
  private readonly subscribers = new Set<() => void>();

  constructor(timeline: ReplayTimeline, startTs?: number) {
    this.timeline = timeline;
    this.playheadTs = clampTs(timeline, startTs ?? timeline.from);
  }

  getState(): ReplayClockState {
    return {
      playheadTs: this.playheadTs,
      playing: this.playing,
      rate: this.rate,
      skipGaps: this.skipGaps,
      seekSeq: this.seekSeq,
      lastSkip: this.lastSkip,
    };
  }

  /** Fires at rAF rate while playing. For UI, prefer the throttled hook state. */
  subscribe(cb: () => void): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  private notify(): void {
    for (const cb of this.subscribers) cb();
  }

  // --- commands ---

  /** Play at the very end restarts from the top. */
  play(): void {
    if (this.playing) return;
    if (this.playheadTs >= this.timeline.to) {
      this.playheadTs = this.timeline.from;
      this.seekSeq++;
    }
    this.playing = true;
    this.notify();
  }

  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    this.notify();
  }

  setRate(rate: ReplayRate): void {
    if (this.rate === rate) return;
    this.rate = rate;
    this.notify();
  }

  setSkipGaps(skip: boolean): void {
    if (this.skipGaps === skip) return;
    this.skipGaps = skip;
    this.notify();
  }

  seek(ts: number): void {
    const clamped = clampTs(this.timeline, ts);
    this.playheadTs = clamped;
    this.seekSeq++;
    this.notify();
  }

  // --- driver inputs ---

  /**
   * Each video tile registers as a pacer candidate. Only the elected candidate
   * is consulted, and only while playing with coverage.
   */
  registerPacer(id: string, candidate: PacerCandidate): () => void {
    this.pacers.set(id, candidate);
    return () => {
      this.pacers.delete(id);
      if (this.electedPacer === id) this.electedPacer = null;
    };
  }

  /** Null while free-running or before the first playing tick with coverage. */
  pacerId(): string | null {
    return this.electedPacer;
  }

  private electPacer(): PacerCandidate | null {
    const incumbent = this.electedPacer ? this.pacers.get(this.electedPacer) : undefined;
    if (incumbent?.covers(this.playheadTs)) return incumbent;
    for (const [id, candidate] of this.pacers) {
      if (candidate.covers(this.playheadTs)) {
        this.electedPacer = id;
        return candidate;
      }
    }
    this.electedPacer = null;
    return null;
  }

  /** One driver tick; `dtMs` is real elapsed ms since the previous tick. */
  tick(dtMs: number): void {
    if (!this.playing) return;
    const pacer = this.electPacer();
    if (pacer) {
      const paced = clampTs(this.timeline, pacer.read());
      if (paced !== this.playheadTs) {
        this.playheadTs = paced;
        this.endCheck();
        this.notify();
      }
      return;
    }
    this.advance(dtMs);
  }

  /** The free-run path (no coverage, or no pacer mounted). Exposed for tests. */
  advance(dtMs: number): void {
    if (!this.playing) return;
    let next = this.playheadTs + dtMs * this.rate;
    if (this.skipGaps) {
      // Jump any manifest gap the playhead sits in or just crossed into.
      // Bounded loop: gaps are disjoint and sorted, so each iteration moves
      // strictly forward.
      for (let i = 0; i < this.timeline.gaps.length; i++) {
        const gap = gapAt(this.timeline, next);
        if (!gap) break;
        this.skipCounter++;
        this.lastSkip = { fromTs: gap.fromTs, toTs: gap.toTs, seq: this.skipCounter };
        next = gap.toTs;
        this.seekSeq++;
      }
    }
    this.playheadTs = clampTs(this.timeline, next);
    this.endCheck();
    this.notify();
  }

  private endCheck(): void {
    if (this.playheadTs >= this.timeline.to) {
      this.playheadTs = this.timeline.to;
      this.playing = false;
    }
  }
}
