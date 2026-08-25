# Changelog

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
