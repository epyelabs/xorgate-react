// ---------------------------------------------------------------------------
// Re-exports from `@xorgate/sdk`
//
// The React package re-exports the backend SDK's vocabulary rather than
// declaring its own, so a component and a server route pass the same object
// around. `@xorgate/sdk` is a hard dependency, not a peer: one resolved copy
// is what makes `instanceof XorgateError` work across the boundary.
// ---------------------------------------------------------------------------

export type {
  AcceptedTransferOffer,
  BulkTransferItem,
  CreatedTransferOffer,
  Device,
  DeviceModel,
  VideoChannel,
  LatestByMetric,
  LatestReading,
  Me,
  MediaSession,
  MetricName,
  Organization,
  PageMeta,
  RecordingRun,
  ReplayGap,
  ReplayManifest,
  ReplaySegment,
  ReplaySession,
  StreamKey,
  TelemetryHistory,
  TelemetryReading,
  TransferAdoption,
  TransferBlocker,
  TransferBlockerCode,
  TransferDeviceInput,
  TransferOffer,
  TransferOfferPreview,
  TransferOfferStatus,
  TransferPreview,
  TransferResult,
  TransferSummary,
  TransferTenancy,
  ScopeAttributeResult,
  Workspace,
  XorgateClient,
} from "@xorgate/sdk";
export { XorgateError, isXorgateError } from "@xorgate/sdk";

// ---------------------------------------------------------------------------
// Provider: configuration, auth and tenancy
// ---------------------------------------------------------------------------

export type {
  Awaitable,
  XorgateConfig,
  LiveCredentials,
  FirstPartyAuth,
  SessionTokenAuth,
  ApiKeyAuth,
  LiveCredentialsAuth,
  XorgateAuth,
  LiveUnavailableReason,
} from "./config.js";
export {
  XorgateProvider,
  useXorgate,
  useXorgateTenancy,
  DEFAULT_BASE_URL,
  type XorgateProviderProps,
} from "./context.js";
export { useLivePlane } from "./live/use-live-plane.js";
export { useLiveCredentials } from "./live/use-live-credentials.js";

// ---------------------------------------------------------------------------
// Live scope: the tenancy the LIVE plane is in, and what to do when it moves
// ---------------------------------------------------------------------------

export { useLiveScope, type UseLiveScope } from "./live/use-live-scope.js";
export {
  useDeviceScope,
  type UseDeviceScope,
  type UseDeviceScopeOptions,
  type DeviceScopeStatus,
} from "./live/use-device-scope.js";

// ---------------------------------------------------------------------------
// The platform slot (0.2.0): host-runtime adapters, browser by default
// ---------------------------------------------------------------------------

export {
  browserPlatform,
  browserSubscribeWake,
  browserRandomId,
  type XorgatePlatform,
} from "./platform.js";
export type {
  WebRtcPlatform,
  PeerConnectionLike,
  SignalingLike,
  TimerHost,
} from "./live/kvs-session.js";
export { createWebRtcPlatform, type WebRtcPlatformOverrides } from "./live/webrtc-platform.js";
export type {
  MqttLikeClient,
  TelemetrySnapshot,
  TelemetryFeedDeps,
} from "./live/telemetry-feed.js";
export type {
  LiveScope,
  MqttConnectionSpec,
  ResolvedLiveCredentials,
} from "./live/credential-resolver.js";
export { parseTelemetryPayload, type ParsedTelemetryPayload } from "./live/payload.js";

// ---------------------------------------------------------------------------
// The query contract and data hooks
// ---------------------------------------------------------------------------

export type { QueryResult, QueryOptions } from "./query/use-query.js";
export {
  useMe,
  useOrganizations,
  useWorkspaces,
  useDevices,
  useDevice,
  useDeviceModel,
  useTelemetryLatest,
  useTelemetryHistory,
  useVideoChannels,
  useRecordingRuns,
  useSessions,
  type UseDevicesParams,
  type UseDevicesResult,
  type UseTelemetryHistoryParams,
  type UseSessionsParams,
  type UseRunsResult,
  type UseSessionsResult,
} from "./query/hooks.js";

// ---------------------------------------------------------------------------
// Live telemetry
// ---------------------------------------------------------------------------

export {
  useLiveTelemetry,
  type UseLiveTelemetry,
  type UseLiveTelemetryOptions,
} from "./live/use-live-telemetry.js";
export type { LiveStatus, TelemetryPoint } from "./live/telemetry-feed.js";
export type {
  TelemetryRecordingStatus,
  TelemetryMediaStatus,
  TelemetryStreamStatus,
  LiveBlockPayload,
} from "./live/payload.js";

// ---------------------------------------------------------------------------
// Live-block policy
// ---------------------------------------------------------------------------

export {
  resolveLiveBlock,
  liveBlockElapsedMs,
  LIVE_BLOCK_STALE_MS,
  type LiveBlockReason,
  type LiveBlockOpenReason,
  type LiveBlockState,
  type ResolveLiveBlockInput,
} from "./live/live-block.js";
export { useLiveBlock } from "./live/use-live-block.js";

// ---------------------------------------------------------------------------
// Live video
// ---------------------------------------------------------------------------

export {
  useLiveVideo,
  type UseLiveVideo,
  type UseLiveVideoOptions,
  type LiveVideoStatus,
  type LiveVideoStats,
} from "./live/use-live-video.js";
export {
  useLiveVideoSession,
  type UseLiveVideoSession,
  type UseLiveVideoSessionOptions,
} from "./live/use-live-video-session.js";
export { LiveVideo, type LiveVideoProps } from "./live/live-video.js";

// ---------------------------------------------------------------------------
// Replay: pure timeline utilities
// ---------------------------------------------------------------------------

export {
  buildTimeline,
  segmentEnd,
  segmentAt,
  hasCoverageAt,
  gapAt,
  nextSegmentAfter,
  prevBoundary,
  nextBoundary,
  clampTs,
  type ReplayTimeline,
} from "./replay/timeline.js";
export {
  buildLanes,
  buildClockTimeline,
  segmentUrlKey,
  type ReplayLane,
  type LaneSegment,
} from "./replay/lanes.js";
export {
  ReplayClock,
  REPLAY_RATES,
  type ReplayRate,
  type ReplayClockState,
  type PacerCandidate,
  type GapSkipEvent,
} from "./replay/replay-clock.js";
export { parseSegmentMediaInfo, type SegmentMediaInfo } from "./replay/mp4-box.js";

// ---------------------------------------------------------------------------
// Replay: hooks and component
// ---------------------------------------------------------------------------

export {
  useReplayManifest,
  type UseReplayManifestParams,
  type UseReplayManifestResult,
} from "./replay/use-replay-manifest.js";
export {
  useReplayPlayer,
  type UseReplayPlayer,
  type UseReplayPlayerOptions,
  type ReplayLaneState,
  type ReplayLaneStatus,
} from "./replay/use-replay-player.js";
export {
  useReplayPlayerCore,
  type UseReplayPlayerCore,
} from "./replay/use-replay-player-core.js";
export type {
  ReplayEngine,
  ReplayEngineOptions,
  ReplayEngineFactory,
} from "./replay/replay-engine.js";
export {
  useReplayTelemetry,
  type UseReplayTelemetry,
  type UseReplayTelemetryOptions,
} from "./replay/use-replay-telemetry.js";
export { ReplayVideo, type ReplayVideoProps } from "./replay/replay-video.js";

// ---------------------------------------------------------------------------
// Replay: telemetry math
// ---------------------------------------------------------------------------

export {
  seriesFromReadings,
  floorIndex,
  latestWithin,
  metricGroup,
  stalenessMs,
  overviewStalenessMs,
  chooseIntervalSeconds,
  windowBoundsFor,
  windowNeedsRefetch,
  buildTrace,
  traceLines,
  traveledLines,
  positionAt,
  GROUP_STALENESS_MS,
  DEFAULT_STALENESS_MS,
  WINDOW_SPAN_MS,
  WINDOW_MIN_SPAN_MS,
  type MetricSeries,
  type GpsTrace,
  type WindowBounds,
  type PositionResolution,
} from "./replay/replay-telemetry.js";

// ---------------------------------------------------------------------------
// Escape hatch for the live plane
// ---------------------------------------------------------------------------

export { presignIotWssUrl } from "./live/iot-wss.js";
