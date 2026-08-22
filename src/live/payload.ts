import type { StreamKey } from "@xorgate/sdk";

/**
 * The device's telemetry payload v1, validated by hand because this package
 * carries no schema library. The posture copies xorgate-web's zod schema
 * exactly: `metrics` must parse or the payload is dropped, while the `media`
 * and `recording` blocks are validated defensively and INDEPENDENTLY — a shape
 * change in either must never drop the whole payload, so a malformed block is
 * treated as absent and the metrics still land.
 *
 * These types mirror the device agent's own status types and the backend's
 * telemetry schema. There is no generated contract for them; changing one
 * means changing all three together.
 */

/** The device's `recording` block, payload v1. Best-effort on old agents. */
export interface TelemetryRecordingStatus {
  enabled: boolean;
  sessionId: string | null;
  backlogBytes: number;
  backlogSegments: number;
  droppedSegments: number;
  uploading: boolean;
  /** Epoch ms in the DEVICE's clock domain. */
  lastUploadAt: number | null;
  /** Boot power staging: `off` | `skipped` | `deferring` | `gating` | `released:<why>`. */
  bootDefer?: string;
  /** Load-shed rung: `no-live` | `bridge-only`, prefixed `parked:` once the cycle cap is spent. */
  powerShed?: string;
  liveBlock?: LiveBlockPayload;
}

/** The `recording.liveBlock` object as it arrives from the device. */
export interface LiveBlockPayload {
  reason: string;
  detail: string;
  /** Epoch ms in the DEVICE's clock domain. */
  since: number;
}

/** One supervised video master. `state` is device-side supervisor prose, not a closed set. */
export interface TelemetryStreamStatus {
  streamKey: StreamKey;
  channelName: string;
  state: string;
}

export interface TelemetryMediaStatus {
  /** Whether the live-video masters are up. */
  kvs?: { value: boolean };
  /** Whether on-device video recording is running. */
  recording?: { value: boolean };
  streams?: TelemetryStreamStatus[];
}

export interface ParsedTelemetryPayload {
  ts: number;
  /** `group.field` to numeric leaf. */
  metrics: Array<{ metric: string; value: number; unit?: string }>;
  recording: TelemetryRecordingStatus | null;
  media: TelemetryMediaStatus | null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Parse one wire payload. Returns null when the frame is not payload v1. */
export function parseTelemetryPayload(json: unknown): ParsedTelemetryPayload | null {
  if (!isObject(json)) return null;
  if (json.v !== 1) return null;
  if (!num(json.ts)) return null;

  const metrics: ParsedTelemetryPayload["metrics"] = [];
  if (json.metrics !== undefined) {
    if (!isObject(json.metrics)) return null;
    for (const [group, fields] of Object.entries(json.metrics)) {
      if (!isObject(fields)) return null;
      for (const [field, leaf] of Object.entries(fields)) {
        if (!isObject(leaf) || !num(leaf.value)) return null;
        metrics.push({
          metric: `${group}.${field}`,
          value: leaf.value,
          ...(typeof leaf.unit === "string" ? { unit: leaf.unit } : {}),
        });
      }
    }
  }

  return {
    ts: json.ts,
    metrics,
    recording: parseRecording(json.recording),
    media: parseMedia(json.media),
  };
}

/** Defensive: a malformed block is absent, never a dropped payload. */
function parseRecording(v: unknown): TelemetryRecordingStatus | null {
  if (!isObject(v)) return null;
  if (
    typeof v.enabled !== "boolean" ||
    !(v.sessionId === null || typeof v.sessionId === "string") ||
    !num(v.backlogBytes) ||
    !num(v.backlogSegments) ||
    !num(v.droppedSegments) ||
    typeof v.uploading !== "boolean" ||
    !(v.lastUploadAt === null || num(v.lastUploadAt))
  ) {
    return null;
  }
  const out: TelemetryRecordingStatus = {
    enabled: v.enabled,
    sessionId: v.sessionId,
    backlogBytes: v.backlogBytes,
    backlogSegments: v.backlogSegments,
    droppedSegments: v.droppedSegments,
    uploading: v.uploading,
    lastUploadAt: v.lastUploadAt,
  };
  if (typeof v.bootDefer === "string") out.bootDefer = v.bootDefer;
  if (typeof v.powerShed === "string") out.powerShed = v.powerShed;
  // `reason` is deliberately an OPEN string: an enum here would reject a
  // future reason and silently discard the whole block, turning a
  // forward-compatible field into a fail-open hole.
  if (
    isObject(v.liveBlock) &&
    typeof v.liveBlock.reason === "string" &&
    typeof v.liveBlock.detail === "string" &&
    num(v.liveBlock.since)
  ) {
    out.liveBlock = {
      reason: v.liveBlock.reason,
      detail: v.liveBlock.detail,
      since: v.liveBlock.since,
    };
  }
  return out;
}

function parseMedia(v: unknown): TelemetryMediaStatus | null {
  if (!isObject(v)) return null;
  const out: TelemetryMediaStatus = {};
  if (isObject(v.kvs) && typeof v.kvs.value === "boolean") out.kvs = { value: v.kvs.value };
  if (isObject(v.recording) && typeof v.recording.value === "boolean") {
    out.recording = { value: v.recording.value };
  }
  if (Array.isArray(v.streams)) {
    const streams: TelemetryStreamStatus[] = [];
    for (const s of v.streams) {
      if (
        isObject(s) &&
        typeof s.streamKey === "string" &&
        typeof s.channelName === "string" &&
        typeof s.state === "string"
      ) {
        streams.push({ streamKey: s.streamKey, channelName: s.channelName, state: s.state });
      } else {
        return out.kvs || out.recording ? out : null;
      }
    }
    out.streams = streams;
  }
  return out;
}
