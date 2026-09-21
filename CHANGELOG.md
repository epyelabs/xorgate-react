# Changelog

## 0.3.1

### Fixed

- **`invalidateScope()` now discards a vend that was already IN FLIGHT**, and
  not just the cached credential. `getCredentials()` hands back a pending
  `inflight` promise before it considers minting, so a vend issued moments
  before a tenancy change was adopted as the NEW tenancy's credential and
  cached for its full ~55-minute lifetime. Live video then failed
  `kinesisvideo:GetSignalingChannelEndpoint` with `AccessDenied` against a
  channel in the organization the user had just switched TO, and telemetry went
  silent, until the credential expired.

  Dropping `inflight` alone would not have been enough: the orphaned vend's
  continuations still wrote `cache`, and `adoptVendScope` still wrote the
  learned scope. Both are now guarded by a generation counter that
  `invalidateScope()` bumps, so a vend issued before the switch can no longer
  land anywhere after it. Callers already awaiting that promise still receive
  it — they asked before the switch — it simply is not retained.

  Reproduced on hardware (iOS and Android) on 2026-09-21 by switching
  organizations while a vend was in flight; covered by
  `test/live-scope.test.ts`.

## 0.3.0

Live scope. The device your viewer is watching can be transferred to another
workspace or organization while the viewer is open, and until now **nothing
told it**. This release is the fix, plus a re-export of the transfer vocabulary
from `@xorgate/sdk` 0.7.0.

### The problem, stated plainly

A vended live credential encodes org + workspace in its session policy, and this
package caches it until about five minutes before expiry — up to roughly **50
minutes**. Inside that window a transfer produces no error of any kind:

- **Telemetry goes silent.** The subscription names
  `xorgate/orgs/{org}/ws/{ws}/devices/{id}/telemetry` with the old ids spelled
  out concretely; the device now publishes under different ones. The socket
  stays `connected` and no frame ever arrives, which is indistinguishable from
  an idle device.
- **Video keeps working, then stops.** KVS authorizes on a resource tag with no
  MQTT session involved, so an established session flows until it is cycled and
  the next connect gets `AccessDenied`.

This is invisible from `console.xorgate.io`, which subscribes to **both**
telemetry planes with wildcards and therefore renders a transferred device
perfectly. Only a workspace-scoped consumer sees it — which is exactly who saw
it on 2026-09-18.

### Added

- **`useLiveScope()`** — the tenancy the LIVE credential was vended for (not the
  provider's props, which is what `useXorgateTenancy()` reports), plus
  `invalidate()`. Call `invalidate()` after `devices.transfer()` or
  `transferOffers.accept()`: it drops the credential, forgets the learned scope,
  and makes every live consumer re-resolve immediately.

- **`useDeviceScope(deviceId)`** — turns the silence into a typed error. It
  reads the device over REST and compares its `workspaceId` against the live
  credential's scope. A mismatch **re-vends once** (the ordinary cause is just a
  stale cached credential) and only then fails loudly with
  `DEVICE_OUT_OF_SCOPE`. A device the REST plane 404s is out of scope too: it
  moved to another organization.

  ```tsx
  const scope = useDeviceScope(deviceId)
  const live = useLiveTelemetry(scope.outOfScope ? null : deviceId)
  if (scope.error) return <Banner>{scope.error.message}</Banner>
  ```

  Its fourth status, `"unknown"`, is a real answer and never a problem signal:
  a first-party Cognito session and an organization-scoped credential are not
  workspace-scoped at all, so there is nothing to compare.

- **`LiveScope`** type, and the transfer vocabulary re-exported from
  `@xorgate/sdk` (`TransferSummary`, `TransferPreview`, `TransferOffer`,
  `TransferOfferPreview`, `TransferAdoption`, `ScopeAttributeResult` and the
  rest), so a component and a server route pass the same objects around.

### Changed

- **The live hooks now re-open when the scope is invalidated.** Previously
  `invalidate()` existed on the resolver and **nothing called it on a tenancy
  change**, and even calling it would not have reconnected an already-open
  socket. `useLiveTelemetry` now drops and re-opens its MQTT connection, and
  `useLiveVideoSession` cycles its peer connection, when `useLiveScope()
  .invalidate()` runs. Both do so from ANY state including `connected`, because
  connected-but-wrong is precisely the case.

  This is a behaviour change for anyone who was tolerating a blank feed after a
  transfer: they now get a reconnect, and with `useDeviceScope` mounted, an
  error instead of nothing.

- **`LiveCredentialResolver.invalidate()` is unchanged and still notifies
  nobody** — it is the expiry path, and the KVS session cycles credentials with
  it on a timer. The new `invalidateScope()` is the tenancy path. Keeping them
  separate stops video's 50-minute credential cycle from bouncing the telemetry
  socket.

- Requires `@xorgate/sdk` `^0.7.0`.

## 0.2.1

Types only. No runtime change: `dist/index.js` is byte-identical to 0.2.0 and
the one emitted file that moved differs by a doc comment.

- `useReplayTelemetry(deviceId, player)` now takes `UseReplayPlayerCore`, not
  the browser `UseReplayPlayer`. It reads a timeline and a playhead and has no
  idea what is playing the video, so requiring a `laneVideoRef` shut React
  Native out of a hook that works there unchanged. `UseReplayPlayer` extends
  the core, so every browser caller is unaffected.

  Supersedes 0.2.0, which was cut but never published.

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
