// End-to-end suite: drives the BUILT package (dist/) in headless Chromium
// against PRODUCTION, in the proxied-consumer shape (the harness server holds
// the key). Three scenarios: live telemetry, live video, and the Sessions
// acceptance test — video and telemetry replaying on one synced timeline,
// where scrub, seek and pause keep both streams aligned.
//
// Credentials come from a gitignored .env (see .env.example). Unconfigured,
// the suite SKIPS — unless XORGATE_REQUIRE_E2E=1, under which missing
// credentials FAIL: a green run that tested nothing is the state everyone
// stops looking at (the lesson Phase 1 paid for).
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";
import { loadEnv, startServer } from "./server.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(root, "..");
const envPath = process.env.XORGATE_ENV_FILE ?? path.join(repo, ".env");
const require_ = process.env.XORGATE_REQUIRE_E2E === "1";

if (!existsSync(envPath)) {
  if (require_) {
    console.error(`XORGATE_REQUIRE_E2E=1 but ${envPath} is missing`);
    process.exit(1);
  }
  console.log(`e2e SKIPPED: no ${envPath}. Copy .env.example and fill it in.`);
  process.exit(0);
}
const env = loadEnv(envPath);
const DEVICE = env.XORGATE_TEST_DEVICE_ID;
const WORKSPACE = env.XORGATE_TEST_WORKSPACE_ID;
if (!DEVICE || !WORKSPACE) {
  const msg = "e2e needs XORGATE_TEST_DEVICE_ID and XORGATE_TEST_WORKSPACE_ID";
  if (require_) {
    console.error(msg);
    process.exit(1);
  }
  console.log(`e2e SKIPPED: ${msg}`);
  process.exit(0);
}
const BASE_URL = env.XORGATE_API_URL ?? "https://api.xorgate.io";

// --- build the app bundle against the REAL built package -------------------
if (!existsSync(path.join(repo, "dist", "index.js"))) {
  console.error("dist/ missing — run `npm run build` first");
  process.exit(1);
}
const esbuild = path.join(repo, "node_modules", ".bin", "esbuild");
execFileSync(
  esbuild,
  [
    path.join(root, "app.tsx"),
    "--bundle",
    "--format=iife",
    "--jsx=automatic",
    `--outfile=${path.join(root, ".bundle.js")}`,
    `--alias:@xorgate/react=${path.join(repo, "dist", "index.js")}`,
    "--define:process.env.NODE_ENV='\"production\"'",
    // Some transitive deps (KVS signaling client) read bare `process`.
    "--banner:js=var process=globalThis.process??{env:{}};",
  ],
  { stdio: "inherit" },
);
const bundle = readFileSync(path.join(root, ".bundle.js"), "utf8");

const artifacts = path.join(root, "artifacts");
mkdirSync(artifacts, { recursive: true });

// --- helpers ---------------------------------------------------------------
let currentTest = null;
const results = [];

function assert(cond, label) {
  results.push({ label: `${currentTest}: ${label}`, ok: !!cond });
  if (!cond) console.error(`  FAIL ${label}`);
  else console.log(`  ok   ${label}`);
}

async function waitState(page, predicate, timeoutMs, label) {
  try {
    await page.waitForFunction(predicate, null, { timeout: timeoutMs });
    return true;
  } catch {
    const state = await page.evaluate(() => window.__STATE).catch(() => null);
    console.error(`  TIMEOUT waiting for ${label}; state=${JSON.stringify(state)}`);
    return false;
  }
}

const snap = (page) => page.evaluate(() => window.__STATE);

// --- run -------------------------------------------------------------------
const server = await startServer({
  env,
  baseUrl: BASE_URL,
  workspaceId: WORKSPACE,
  bundle: () => bundle,
  testConfig: () => config,
});
let config = null;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.on("pageerror", (e) => console.error("  pageerror:", String(e).slice(0, 300)));

// ===========================================================================
// 1. Live telemetry through the package, vended credentials
// ===========================================================================
currentTest = "live-telemetry";
console.log("\n[1/3] live telemetry (vended credentials, tenant-scoped topic)");
config = { test: "live-telemetry", deviceId: DEVICE, organizationId: env.XORGATE_ORG_ID };
await page.goto(server.url);
{
  const connected = await waitState(
    page,
    () => window.__STATE.status === "connected",
    60_000,
    "status=connected",
  );
  assert(connected, "feed connects over MQTT-WSS");
  const gotData = await waitState(
    page,
    () => window.__STATE.metricCount > 0,
    30_000,
    "first payload",
  );
  assert(gotData, "live payload arrives");
  if (gotData) {
    const s = await snap(page);
    assert(s.metricCount >= 10, `a real metric set (${s.metricCount} metrics)`);
    const lat = s.gpsLat;
    assert(
      lat && lat.metric === "gps.lat" && typeof lat.value === "number" && typeof lat.ts === "string",
      "latest is the SDK interop shape (metric, value, ISO ts)",
    );
    assert(
      typeof s.receivedAt === "number" && Date.now() - s.receivedAt < 30_000,
      "receivedAt is a fresh browser-clock stamp",
    );
    assert(s.recordingBlock === true, "the recording status block rides along");
  }
}

// ===========================================================================
// 2. Live video through the package
// ===========================================================================
currentTest = "live-video";
console.log("\n[2/3] live video (KVS WebRTC viewer, vended credentials)");
{
  const { channels } = await server.api(`/devices/${DEVICE}/video-channels`);
  const cam0 = channels.find((c) => c.streamKey === "cam0");
  config = { test: "live-video", deviceId: DEVICE, organizationId: env.XORGATE_ORG_ID, channel: cam0 };
  await page.goto(server.url);
  const connected = await waitState(
    page,
    () => window.__STATE.status === "connected",
    90_000,
    "status=connected",
  );
  assert(connected, "viewer reaches connected");
  const gotFrames = await waitState(
    page,
    () => window.__STATE.stats && window.__STATE.stats.width > 0,
    30_000,
    "decoded frames in stats",
  );
  assert(gotFrames, "inbound-rtp reports decoded frames");
  if (gotFrames) {
    const s = await snap(page);
    console.log(`  receiving ${s.stats.width}x${s.stats.height} @ ${s.stats.fps ?? "?"} fps`);
    assert(s.stats.width >= 640, "real resolution");
    await page.locator("video").screenshot({ path: path.join(artifacts, "live-video.png") });
  }
}

// ===========================================================================
// 3. THE SESSIONS ACCEPTANCE TEST: synced replay of a real recorded session
// ===========================================================================
currentTest = "replay";
console.log("\n[3/3] Sessions acceptance: synced video+telemetry replay");
{
  const sessions = await server.api(`/devices/${DEVICE}/sessions?limit=1`);
  const sessionId = sessions.sessions[0].id;
  const manifestBody = await server.api(
    `/devices/${DEVICE}/replay-manifest?sessionId=${sessionId}`,
  );
  const manifest = manifestBody.replay ?? manifestBody;
  console.log(
    `  session ${sessionId} — ${manifest.sessions[0].segments.length} segments, ` +
      `${Math.round((manifest.to - manifest.from) / 60000)} min`,
  );
  config = {
    test: "replay",
    deviceId: DEVICE,
    organizationId: env.XORGATE_ORG_ID,
    manifest,
    metrics: ["gps.lat", "gps.lon", "gps.speed", "system.cpu_temp", "system.cpu_usage"],
  };
  await page.goto(server.url);

  const laneReady = await waitState(
    page,
    () => window.__STATE.laneStatus === "ready",
    60_000,
    "lane ready (first frame decoded via MSE)",
  );
  assert(laneReady, "MSE lane decodes its first frame");
  await page
    .locator("video")
    .screenshot({ path: path.join(artifacts, "replay-poster.png") })
    .catch(() => {});

  const telemetryUp = await waitState(
    page,
    () => Object.keys(window.__STATE.latest ?? {}).length > 0 && window.__STATE.telemetryLoading === false,
    60_000,
    "replay telemetry overview",
  );
  assert(telemetryUp, "replay telemetry resolves at the playhead");

  // --- PLAY: the pacer contract -------------------------------------------
  await page.evaluate(() => window.__PLAYER.play());
  await page.waitForTimeout(4000);
  const p1 = await snap(page);
  await page.waitForTimeout(3000);
  const p2 = await snap(page);
  assert(p2.playing === true, "playing");
  assert(p2.playheadTs > p1.playheadTs + 2000, "playhead advances with playback");
  assert(p2.videoPaused === false, "video element is playing");
  assert(p2.isPacer === true, "the video element paces the clock");
  const wallClock = (s) => s.timeline.from + s.videoCurrentTime * 1000;
  assert(
    Math.abs(wallClock(p2) - p2.playheadTs) < 300,
    `video and playhead aligned while playing (drift ${Math.round(Math.abs(wallClock(p2) - p2.playheadTs))} ms)`,
  );
  {
    const m = p2.latest["system.cpu_temp"] ?? p2.latest["system.cpu_usage"];
    assert(
      m !== undefined && Math.abs(Date.parse(m.ts) - p2.playheadTs) <= 10_000,
      "telemetry readout tracks the playhead while playing",
    );
  }
  if (p2.latest["gps.lat"]) {
    assert(
      Math.abs(Date.parse(p2.latest["gps.lat"].ts) - p2.playheadTs) <= 5_000,
      "gps readout inside its staleness window",
    );
  }
  await page.locator("video").screenshot({ path: path.join(artifacts, "replay-playing.png") });

  // --- PAUSE: everything freezes together ---------------------------------
  await page.evaluate(() => window.__PLAYER.pause());
  await page.waitForTimeout(500);
  const f1 = await snap(page);
  await page.waitForTimeout(1500);
  const f2 = await snap(page);
  assert(f2.playing === false, "paused");
  assert(f2.playheadTs === f1.playheadTs, "playhead frozen while paused");
  assert(f2.videoPaused === true, "video element paused with the clock");
  assert(f2.videoCurrentTime === f1.videoCurrentTime, "video frame frozen while paused");

  // --- SEEK while paused: both streams land together ----------------------
  const seekTarget = manifest.from + 5 * 60_000;
  await page.evaluate((ts) => window.__PLAYER.seek(ts), seekTarget);
  await page.waitForTimeout(1000);
  const s1 = await snap(page);
  assert(
    Math.abs(s1.playheadTs - seekTarget) < 1000,
    `seek moves the playhead (${Math.round(Math.abs(s1.playheadTs - seekTarget))} ms off target)`,
  );
  const videoLanded = await waitState(
    page,
    () => {
      const st = window.__STATE;
      return (
        st.videoCurrentTime !== null &&
        Math.abs(st.timeline.from + st.videoCurrentTime * 1000 - st.playheadTs) < 500
      );
    },
    20_000,
    "video re-aligns after seek",
  );
  assert(videoLanded, "video element lands on the seek target");
  // The bench Pi is stationary, so its persisted GPS rows are sparse and the
  // 5 s gps staleness window correctly BLANKS the metric between them (the
  // documented "a stale metric disappears rather than freezing" behaviour).
  // Alignment is asserted on the dense system group (10 s staleness) instead.
  const telemetryLanded = await waitState(
    page,
    () => {
      const st = window.__STATE;
      const m = st.latest["system.cpu_temp"] ?? st.latest["system.cpu_usage"];
      return m !== undefined && Math.abs(Date.parse(m.ts) - st.playheadTs) <= 10_000;
    },
    20_000,
    "telemetry re-resolves at the seek target",
  );
  assert(telemetryLanded, "telemetry lands on the seek target with the video");
  await page.locator("video").screenshot({ path: path.join(artifacts, "replay-seeked.png") });

  // --- SCRUB then RESUME: alignment survives ------------------------------
  const scrubTarget = manifest.from + 9 * 60_000;
  await page.evaluate((ts) => window.__PLAYER.seek(ts), scrubTarget);
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.__PLAYER.play());
  await page.waitForTimeout(4000);
  const r1 = await snap(page);
  assert(r1.playing === true, "resumes after scrub");
  assert(
    r1.playheadTs > scrubTarget + 1500 && r1.playheadTs < scrubTarget + 30_000,
    "playback continues from the scrub target",
  );
  assert(
    Math.abs(wallClock(r1) - r1.playheadTs) < 300,
    `alignment survives scrub+resume (drift ${Math.round(Math.abs(wallClock(r1) - r1.playheadTs))} ms)`,
  );
  {
    const m = r1.latest["system.cpu_temp"] ?? r1.latest["system.cpu_usage"];
    assert(
      m !== undefined && Math.abs(Date.parse(m.ts) - r1.playheadTs) <= 10_000,
      "telemetry still tracks after scrub+resume",
    );
  }
  await page.evaluate(() => window.__PLAYER.pause());
}

await browser.close();
server.close();

// --- report ----------------------------------------------------------------
const failed = results.filter((r) => !r.ok);
console.log(`\n# e2e results: ${results.length - failed.length}/${results.length} passed`);
for (const f of failed) console.log(`  FAILED: ${f.label}`);
process.exit(failed.length === 0 ? 0 : 1);
