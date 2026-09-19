# @xorgate/react

[![npm](https://img.shields.io/npm/v/@xorgate/react.svg)](https://www.npmjs.com/package/@xorgate/react)
[![CI](https://github.com/epyelabs/xorgate-react/actions/workflows/ci.yml/badge.svg)](https://github.com/epyelabs/xorgate-react/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@xorgate/react.svg)](./LICENSE)

The headless React SDK for the [xorgate](https://xorgate.io) platform: data
hooks over [`@xorgate/sdk`](https://www.npmjs.com/package/@xorgate/sdk), live
telemetry over MQTT-over-WebSocket, live video over WebRTC, and the
recorded-media replay player with video and telemetry on one synced timeline.

Headless means headless: hooks return state and refs; you render. Two
components ship (`LiveVideo`, `ReplayVideo`) and each is a hook plus a bare
`<video>` element.

**Full reference: [docs.xorgate.io/docs/frontend-sdk](https://docs.xorgate.io/docs/frontend-sdk)**

## Install

```bash
npm install @xorgate/react @xorgate/sdk react
```

`react` (`^18.2 || ^19`) is the only peer. `@xorgate/sdk` is a hard dependency
on purpose: one resolved copy is what makes `import type { Device }` from
either package the identical type, and `instanceof XorgateError` true across
the boundary. ESM only, browser only, types bundled.

## Use

```tsx
import { XorgateProvider, useDevices, useLiveTelemetry } from "@xorgate/react"

function App() {
  return (
    <XorgateProvider
      auth={{ getSessionToken: () => myBackend.getXorgateSessionToken() }}
      organizationId={orgId}
    >
      <Fleet />
    </XorgateProvider>
  )
}

function Fleet() {
  const { data: devices, isLoading } = useDevices({ status: "online" })
  if (isLoading) return <p>Loading…</p>
  return devices?.map((d) => <DeviceRow key={d.id} device={d} />)
}
```

## Auth modes

- **`{ getSessionToken }`** — the third-party default. Your server exchanges
  its API key for a short-lived `xgs_` token; the SDK authenticates REST with
  it and exchanges it for live-plane credentials itself. Config collapses to
  nothing (`baseUrl` defaults to production).
- **`{ getLiveCredentials }`** — the fully proxied profile. Your backend holds
  the key, serves all REST to your own frontend, and vends live credentials
  via `POST /auth/live-credentials`; hand the response to this callback
  verbatim and the browser touches no xorgate REST endpoint at all. Live
  hooks and the replay player are the whole surface in this mode.
- **`{ getIdToken }`** — first-party Cognito, for xorgate's own dashboard.
- **`{ apiKey }`** — REST only, for React rendered on a server you control. A
  key in a browser bundle is a published key.

## What you get

- **One metric contract.** Live MQTT, `useTelemetryLatest` and replayed
  telemetry all produce `Record<"group.field", LatestReading>`, so one readout
  component renders all three without knowing which it has.
- **One socket per device.** Live telemetry consumers share a ref-counted
  MQTT connection; mounting the hook in five components costs one socket.
- **Reconnect machinery that survived real LTE devices.** Generation counters,
  per-step and whole-attempt deadlines, an ICE disconnect grace window,
  backoff, a proactive credential cycle and mobile visibility nudges, on both
  live planes.
- **A replay player with one wall clock.** Video elements pace the clock;
  telemetry resolves at the playhead; drift between them is structurally
  impossible rather than merely small. fMP4 over MSE, gap-aware, with
  presigned-URL refresh that never resets the clock.
- **A small bundle for pages that need none of that.** Every live dependency
  (mqtt, the KVS and Cognito clients) sits behind a dynamic import; a page
  that only lists devices ships a few kB of this package and zero AWS code.
- **A live plane that notices when the device moves.** A vended credential
  encodes org + workspace and is cached for up to ~50 minutes, so a device
  transferred to another workspace leaves a viewer connected to a topic nothing
  will publish to again — silence, no error. `useDeviceScope(deviceId)` turns
  that into a typed `DEVICE_OUT_OF_SCOPE`, re-vending once first since the usual
  cause is just a stale credential, and `useLiveScope().invalidate()` makes every
  open live consumer re-resolve after you transfer a device yourself.

## Platforms

Everything that touches the host runtime goes through one optional
`platform` prop on `XorgateProvider`, and every slot defaults to the browser,
so a web app never passes it:

```tsx
<XorgateProvider auth={auth} organizationId={orgId} platform={nativePlatform()}>
```

`XorgatePlatform` has four slots: `createWebRtcPlatform` (the KVS viewer's
WebRTC), `subscribeWake` (foreground / network-back events that nudge the
live planes and `refetchOnFocus`), `mqttConnect` (the MQTT transport) and
`randomId` (client-id entropy). React Native consumers install
[`@xorgate/react-native`](https://www.npmjs.com/package/@xorgate/react-native),
which supplies all four plus `useLiveVideo` over `RTCView` and the replay
player over `expo-video`. Adapter authors build on `useLiveVideoSession`,
`useReplayPlayerCore` + `attachLane`, `ReplayEngine` and
`createWebRtcPlatform(overrides)`; the browser hooks are thin wrappers over
the same cores.

## License

MIT © Epye Labs
