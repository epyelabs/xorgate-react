# Changelog

## 0.2.0

Accepted by Phase 6 N2: `@xorgate/react-native` 0.1.0 is built on the platform
slot below and is published, so the pre-release `0.2.0-next.1` is promoted
unchanged — the only difference between them is this version number.

Additive: no web consumer needs a change, and `dist/index.js` differs from
0.1.3 only by what is new. This release makes the package platform-neutral so
`@xorgate/react-native` can supply React Native adapters instead of forking
the session, feed and replay logic.

- **`platform` prop on `XorgateProvider`** (`XorgatePlatform`): four optional
  host-runtime slots, every one defaulting to today's browser behaviour —
  `createWebRtcPlatform`, `subscribeWake` (foreground / network back),
  `mqttConnect`, `randomId`. Read at the point of use, so a page that mounts
  no video still pulls no WebRTC, AWS or mqtt code. `browserPlatform()`,
  `browserSubscribeWake()` and `browserRandomId()` are exported.
- **The credential resolver draws client-id entropy from `randomId`** instead
  of calling `crypto.randomUUID()` directly (React Native ships no `crypto`
  global). The browser default is unchanged; the error a runtime without
  `crypto` gets now names the slot.
- **`TelemetryFeed` gains `nudge()` and a `subscribeWake` dep**: a wake while
  the socket is closed or a backoff is pending reconnects immediately. A
  generation counter guards `open()` so a stalled attempt cannot attach a
  second client after a nudge. `useLiveTelemetry` hands the platform's
  `mqttConnect` / `subscribeWake` to the shared feed.
- **`useLiveVideoSession(channel, { onStream, enabled, statsIntervalMs })`**:
  the platform-neutral core of `useLiveVideo` — status, error and stats, with
  the received stream delivered to `onStream`. `useLiveVideo` keeps its exact
  signature and behaviour as the browser wrapper (`videoRef`, `srcObject`).
  Wake nudges come from the platform (browser: `visibilitychange`,
  `pageshow`, `online`, as before).
- **`createWebRtcPlatform(overrides?)`** accepts `createPeerConnection` and
  `randomId`, so a native platform reuses the three AWS bodies (endpoints,
  ICE servers, signaling) verbatim.
- **`ReplayEngine` / `ReplayEngineOptions` / `ReplayEngineFactory`**: the
  media surface the replay player drives (position, play/pause, rate,
  buffered ranges, stalls, `ensureAt`, `isBufferedAt`), extracted from the MSE
  engine, which now implements it over the `<video>` element.
- **`useReplayPlayerCore(manifest, options)`**: `useReplayPlayer` minus the
  browser's `laneVideoRef`, plus `attachLane(streamKey, factory)`, the seam a
  platform wrapper binds media through. `useReplayPlayer` is the browser
  wrapper (same surface as 0.1.x, `attachLane` additionally exposed).
- **`refetchOnFocus` uses the platform's wake source when one is set**;
  without a platform the browser `visibilitychange` path is unchanged.
- **New root exports** for adapter authors: `WebRtcPlatform`,
  `PeerConnectionLike`, `SignalingLike`, `TimerHost`, `MqttLikeClient`,
  `MqttConnectionSpec`, `ResolvedLiveCredentials`, `TelemetrySnapshot`,
  `TelemetryFeedDeps`, `parseTelemetryPayload` / `ParsedTelemetryPayload`.
- **`@xorgate/sdk` dependency bumped to `^0.6.0`**, so a consumer already on
  0.6 resolves one copy (and `instanceof XorgateError` holds across it).

## 0.1.3

- **`@xorgate/sdk` dependency bumped to `^0.5.0`** (session poster frames).
  Nothing in this package changes: the re-exported `MediaSession` type now
  carries `thumbnailUrl`, and without this bump `^0.4.0` keeps consumers'
  type resolution nested on an SDK a minor behind.

## 0.1.2

- **`@xorgate/sdk` dependency bumped to `^0.4.0`** (camera sensor-level
  rotation). Nothing in this package changes: the hooks pass the new
  `cameraMount` config namespace straight through, and a consumer that wants
  the typed namespace needs this bump only because `^0.3.0` would otherwise
  pin the SDK a minor behind.

## 0.1.1

- **`@xorgate/sdk` dependency bumped to `^0.3.0`** (cm4-support surface).
  The hooks pass the new capability straight through: `useDevice`/`useDevices`
  rows now carry the typed `needsModel`, device models validate as
  `io_capabilities` schemaVersion 1 or 2, and `devices.update({deviceModelId})`
  / `deviceRegistrations.create({deviceModelId})` are available via
  `useXorgate()`. No API changes in this package itself.

## 0.1.0

Initial release: the full designed surface, extracted from xorgate-web and
verified end to end against production hardware.

- `XorgateProvider` with four auth modes: `{ getIdToken }` (first-party
  Cognito), `{ getSessionToken }` (third-party default), `{ apiKey }` (REST
  only), `{ getLiveCredentials }` (fully proxied profile).
- Data hooks over `@xorgate/sdk`: `useMe`, `useOrganizations`,
  `useWorkspaces`, `useDevices`, `useDevice`, `useDeviceModel`,
  `useTelemetryLatest`, `useTelemetryHistory`, `useVideoChannels`,
  `useRecordingRuns`, `useSessions`, plus `useXorgate()` for everything else.
- Live telemetry: `useLiveTelemetry` (one ref-counted socket per device),
  `useLiveBlock`/`resolveLiveBlock`, `useLivePlane`, `useLiveCredentials`,
  `presignIotWssUrl`.
- Live video: `useLiveVideo` and `LiveVideo`, with the full reconnect
  machinery (generation counter, 10 s step and 15 s attempt deadlines, 2.5 s
  ICE disconnect grace, 1–30 s backoff, ~50 min credential cycle, visibility
  nudges).
- Replay: `useReplayManifest`, `useReplayPlayer`, `useReplayTelemetry`,
  `ReplayVideo`, the `ReplayClock` pacer contract, and the exported pure
  timeline/lane/telemetry math.
- Every live dependency is behind a dynamic import; a page that mounts no
  video pulls no KVS, Cognito or mqtt code.
