// End-to-end suite: drives the BUILT package (dist/) in headless Chromium in
// the proxied-consumer shape (the harness server holds the credential).
// Three scenarios: live telemetry, live video, and the Sessions acceptance
// test — video and telemetry replaying on one synced timeline, where scrub,
// seek and pause keep both streams aligned. The Sessions test runs TWICE:
// with the manifest's `telemetry` block (artifact mode: the page must issue
// no `/telemetry?` request) and with `telemetry=0` (the REST fallback).
//
// Credentials come from a gitignored .env (see .env.example), overlaid with
// any XORGATE_* variable in the process environment. CI runs this against
// PRODUCTION with the integration key. Against a stage with no API key at
// hand, `XORGATE_AUTH_MODE=browser-login` logs into the web console through
// its real form (XORGATE_LOGIN_URL / _EMAIL / _PASSWORD) and uses the app's
// own session token, held in memory only, never printed, never written.
//
// Unconfigured, the suite SKIPS — unless XORGATE_REQUIRE_E2E=1, under which
// missing credentials FAIL: a green run that tested nothing is the state
// everyone stops looking at (the lesson Phase 1 paid for).
//
// XORGATE_E2E_ONLY=replay (comma list of live-telemetry, live-video, replay)
// restricts the run; XORGATE_TEST_SESSION_ID pins the replay session;
// XORGATE_E2E_MIN_ROUTE_POINTS (default 0) is the route-line floor asserted
// in artifact mode (a stationary bench device records no route).
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

let env;
try {
  env = loadEnv(envPath);
} catch (err) {
  if (require_) {
    console.error(`XORGATE_REQUIRE_E2E=1 but the suite is unconfigured: ${err.message}`);
    process.exit(1);
  }
  console.log(`e2e SKIPPED: ${err.message}. Copy .env.example to .env and fill it in.`);
  process.exit(0);
}
const DEVICE = env.XORGATE_TEST_DEVICE_ID;
const WORKSPACE = env.XORGATE_TEST_WORKSPACE_ID;
const BROWSER_LOGIN = env.XORGATE_AUTH_MODE === "browser-login";
const ONLY = new Set((env.XORGATE_E2E_ONLY ?? "live-telemetry,live-video,replay").split(","));
const MIN_ROUTE_POINTS = Number(env.XORGATE_E2E_MIN_ROUTE_POINTS ?? 0);
if (!DEVICE || (!WORKSPACE && (ONLY.has("live-telemetry") || ONLY.has("live-video")))) {
  const msg = "e2e needs XORGATE_TEST_DEVICE_ID and XORGATE_TEST_WORKSPACE_ID";
  if (require_) {
    console.error(msg);
    process.exit(1);
  }
  console.log(`e2e SKIPPED: ${msg}`);
  process.exit(0);
}
if (BROWSER_LOGIN) {
  const missing = ["XORGATE_LOGIN_URL", "XORGATE_LOGIN_EMAIL", "XORGATE_LOGIN_PASSWORD"].filter((k) => !env[k]);
  if (missing.length) {
    console.error(`browser-login needs ${missing.join(", ")} in the environment`);
    process.exit(1);
  }
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

const browser = await chromium.launch({ headless: true });

// --- credential -------------------------------------------------------------
// In browser-login mode the session token lives in this closure and nowhere
// else: not in `env`, not in a file, not in any log line.
let sessionToken = null;
if (BROWSER_LOGIN) {
  console.log(`\n[auth] browser login at ${env.XORGATE_LOGIN_URL}`);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const captured = new Promise((resolve) => {
    page.on("request", (req) => {
      if (!req.url().includes("/v1/")) return;
      const auth = req.headers()["authorization"];
      if (auth && auth.startsWith("Bearer ")) resolve(auth.slice("Bearer ".length));
    });
  });
  await page.goto(env.XORGATE_LOGIN_URL, { waitUntil: "domcontentloaded" });
  await page.fill("#email", env.XORGATE_LOGIN_EMAIL);
  await page.fill("#password", env.XORGATE_LOGIN_PASSWORD);
  await page.keyboard.press("Enter");
  sessionToken = await Promise.race([
    captured,
    new Promise((_, reject) => setTimeout(() => reject(new Error("no /v1/ request within 60 s")), 60_000)),
  ]).catch((err) => {
    console.error(`  login failed: ${err.message}`);
    return null;
  });
  await ctx.close();
  if (!sessionToken) {
    await browser.close();
    process.exit(1);
  }
  console.log("  ok   session token captured (in memory)");
}

// --- run -------------------------------------------------------------------
const server = await startServer({
  env,
  baseUrl: BASE_URL,
  workspaceId: WORKSPACE,
  bundle: () => bundle,
  testConfig: () => config,
  authorization: () => sessionToken ?? env.XORGATE_API_KEY,
});
let config = null;

const page = await browser.newPage();
page.on("pageerror", (e) => console.error("  pageerror:", String(e).slice(0, 300)));

// ===========================================================================
// 1. Live telemetry through the package, vended credentials
// ===========================================================================
if (ONLY.has("live-telemetry")) {
  currentTest = "live-telemetry";
  console.log("\n[1/3] live telemetry (vended credentials, tenant-scoped topic)");
  config = { test: "live-telemetry", deviceId: DEVICE, organizationId: env.XORGATE_ORG_ID };
  await page.goto(server.url);
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
if (ONLY.has("live-video")) {
  currentTest = "live-video";
  console.log("\n[2/3] live video (KVS WebRTC viewer, vended credentials)");
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
// Request accounting for one page visit: what the PAGE fetched, by kind.
function trackRequests(page) {
  const seen = { telemetryApi: 0, artifactGets: [], other: 0 };
  const onRequest = (req) => {
    const u = req.url();
    if (u.includes("/telemetry?")) seen.telemetryApi++;
    else if (u.includes("/telemetry/v1/")) seen.artifactGets.push({ url: u.slice(0, u.indexOf("?")), bytes: null });
    else seen.other++;
  };
  const onResponse = async (res) => {
    const u = res.url();
    if (!u.includes("/telemetry/v1/")) return;
    const key = u.slice(0, u.indexOf("?"));
    const entry = seen.artifactGets.find((e) => e.url === key && e.bytes === null);
    if (entry) entry.bytes = Number(res.headers()["content-length"] ?? 0) || null;
  };
  page.on("request", onRequest);
  page.on("response", onResponse);
  return {
    seen,
    stop: () => {
      page.off("request", onRequest);
      page.off("response", onResponse);
    },
  };
}

async function replayAcceptance(page, { label, manifest, expectSource, metrics }) {
  currentTest = `replay-${label}`;
  config = {
    test: "replay",
    deviceId: DEVICE,
    organizationId: env.XORGATE_ORG_ID,
    manifest,
    metrics,
  };
  const tracker = trackRequests(page);
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
    .screenshot({ path: path.join(artifacts, `replay-${label}-poster.png`) })
    .catch(() => {});

  const telemetryUp = await waitState(
    page,
    () => Object.keys(window.__STATE.latest ?? {}).length > 0 && window.__STATE.telemetryLoading === false,
    60_000,
    "replay telemetry overview",
  );
  assert(telemetryUp, "replay telemetry resolves at the playhead");
  const s0 = await snap(page);
  assert(s0.telemetrySource === expectSource, `telemetry source is ${expectSource} (got ${s0.telemetrySource})`);
  console.log(
    `  telemetry ready ${Math.round(s0.telemetryReadyMs ?? -1)} ms after navigation; ` +
      `${s0.routePoints} route points; hasGps=${s0.hasGps}`,
  );
  if (expectSource === "artifacts") {
    // The whole point: the page never touched the history API.
    assert(tracker.seen.telemetryApi === 0, `no /telemetry? request (${tracker.seen.telemetryApi})`);
    assert(tracker.seen.artifactGets.length > 0, `artifact GETs issued (${tracker.seen.artifactGets.length})`);
    assert(s0.routePoints >= MIN_ROUTE_POINTS, `route line has ≥ ${MIN_ROUTE_POINTS} points (${s0.routePoints})`);
    assert(s0.hasGps === s0.routePoints > 0, "hasGps agrees with the route line");
    const bytes = tracker.seen.artifactGets.reduce((n, e) => n + (e.bytes ?? 0), 0);
    console.log(
      `  artifacts at open: ${tracker.seen.artifactGets.length} GETs, ${bytes} bytes on the wire ` +
        `(${tracker.seen.artifactGets.map((e) => path.basename(e.url) + (e.bytes ? `=${e.bytes}` : "")).join(", ")})`,
    );
  } else {
    assert(tracker.seen.telemetryApi > 0, `REST fallback issued /telemetry? requests (${tracker.seen.telemetryApi})`);
    assert(tracker.seen.artifactGets.length === 0, "no artifact GETs on the REST path");
    console.log(`  REST fallback: ${tracker.seen.telemetryApi} /telemetry? calls at open`);
  }

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
  await page.locator("video").screenshot({ path: path.join(artifacts, `replay-${label}-playing.png`) });

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
  const artifactsBeforeSeek = tracker.seen.artifactGets.length;
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
  await page.locator("video").screenshot({ path: path.join(artifacts, `replay-${label}-seeked.png`) });
  if (expectSource === "artifacts") {
    const fetchedForSeek = tracker.seen.artifactGets.length - artifactsBeforeSeek;
    console.log(`  seek +5 min fetched ${fetchedForSeek} new segment(s)`);
    // Seek BACK into ground already visited: the cache answers, nothing is fetched.
    const before = tracker.seen.artifactGets.length;
    await page.evaluate((ts) => window.__PLAYER.seek(ts), manifest.from);
    await page.waitForTimeout(2500);
    const refetched = tracker.seen.artifactGets.length - before;
    assert(refetched === 0, `seek back to the start refetches nothing (${refetched} GETs)`);
    const keys = tracker.seen.artifactGets.map((e) => e.url);
    assert(new Set(keys).size === keys.length, "every artifact fetched at most once");
    await page.evaluate((ts) => window.__PLAYER.seek(ts), seekTarget);
    await page.waitForTimeout(1000);
  }

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
  tracker.stop();
  return s0;
}

if (ONLY.has("replay")) {
  console.log("\n[3/3] Sessions acceptance: synced video+telemetry replay");
  let sessionId = env.XORGATE_TEST_SESSION_ID;
  if (!sessionId) {
    const sessions = await server.api(`/devices/${DEVICE}/sessions?limit=1`);
    sessionId = sessions.sessions[0].id;
  }
  const withBlock = await server.api(`/devices/${DEVICE}/replay-manifest?sessionId=${sessionId}`);
  const withoutBlock = await server.api(
    `/devices/${DEVICE}/replay-manifest?sessionId=${sessionId}&telemetry=0`,
  );
  const manifest = withBlock.replay ?? withBlock;
  const restManifest = withoutBlock.replay ?? withoutBlock;
  const telemetrySessions = manifest.telemetry?.sessions ?? [];
  console.log(
    `  session ${sessionId} — ${manifest.sessions[0].segments.length} video segments, ` +
      `${Math.round((manifest.to - manifest.from) / 60000)} min; telemetry block: ` +
      (manifest.telemetry
        ? `${telemetrySessions.length} session(s), ${telemetrySessions.reduce((n, s) => n + s.segments.length, 0)} segments, ` +
          `${telemetrySessions.filter((s) => s.overview).length} with an overview`
        : "ABSENT (older server)"),
  );
  const metrics = ["gps.lat", "gps.lon", "gps.speed", "system.cpu_temp", "system.cpu_usage"];
  currentTest = "replay";
  assert(manifest.telemetry !== undefined, "the manifest carries its telemetry block");
  assert(restManifest.telemetry === undefined, "telemetry=0 omits the block");

  // 3a. Artifact mode: the block as served.
  const a = await replayAcceptance(page, { label: "artifacts", manifest, expectSource: "artifacts", metrics });
  // 3b. REST fallback: the same session without the block.
  const b = await replayAcceptance(page, { label: "rest", manifest: restManifest, expectSource: "rest", metrics });
  console.log(
    `  open-to-telemetry: artifacts ${Math.round(a.telemetryReadyMs ?? -1)} ms vs REST ${Math.round(b.telemetryReadyMs ?? -1)} ms ` +
      `(route points ${a.routePoints} vs ${b.routePoints})`,
  );
}

await browser.close();
server.close();

// --- report ----------------------------------------------------------------
const failed = results.filter((r) => !r.ok);
console.log(`\n# e2e results: ${results.length - failed.length}/${results.length} passed`);
for (const f of failed) console.log(`  FAILED: ${f.label}`);
process.exit(failed.length === 0 ? 0 : 1);
