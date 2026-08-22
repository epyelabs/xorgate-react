// Bundle check, from the BUILT output rather than from import statements: a
// page that mounts no video must not pull the KVS or AWS clients, and a page
// that mounts no telemetry must not pull mqtt. The live dependencies sit
// behind dynamic imports, so a splitting bundler puts them in lazy chunks; the
// ENTRY chunk of a REST-only app must be free of them.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(repo, "dist", "index.js");
const esbuild = path.join(repo, "node_modules", ".bin", "esbuild");

const work = mkdtempSync(path.join(tmpdir(), "xg-react-bundle-"));
const entry = path.join(work, "app.tsx");
writeFileSync(
  entry,
  `import { XorgateProvider, useDevices, useTelemetryLatest } from "@xorgate/react";
export function App() {
  const { data } = useDevices();
  const { data: latest } = useTelemetryLatest(data?.[0]?.id ?? null);
  return { data, latest };
}
`,
);

const outdir = path.join(work, "out");
execFileSync(esbuild, [
  entry,
  "--bundle",
  "--format=esm",
  "--splitting",
  "--jsx=automatic",
  `--outdir=${outdir}`,
  `--alias:@xorgate/react=${dist}`,
  "--external:react",
  "--external:react/jsx-runtime",
  "--minify",
]);

// The live-plane machinery that must stay OUT of the entry chunk. These are
// source-level markers that survive minification (import specifiers become
// chunk references; runtime strings remain).
const FORBIDDEN = [
  "kinesis", // KVS clients + signaling
  "GetIceServerConfig",
  "cognito-identity",
  "mqtt", // mqtt.js
  "iotdevicegateway", // the SigV4 presigner
];

const files = readdirSync(outdir);
const entryChunk = files.find((f) => f.startsWith("app"));
const entryCode = readFileSync(path.join(outdir, entryChunk), "utf8").toLowerCase();

let failed = false;
for (const marker of FORBIDDEN) {
  if (entryCode.includes(marker.toLowerCase())) {
    console.error(`FAIL: entry chunk contains "${marker}" — a REST-only page is paying for the live plane`);
    failed = true;
  }
}

// Sanity: the lazy chunks must EXIST, or the dynamic imports were bundled away.
const lazy = files.filter((f) => f !== entryChunk && f.endsWith(".js"));
const lazyCode = lazy.map((f) => readFileSync(path.join(outdir, f), "utf8")).join("");
if (!/kinesis/i.test(lazyCode) && !/mqtt/i.test(lazyCode)) {
  console.error("FAIL: no lazy chunk carries the live machinery — did the dynamic imports disappear?");
  failed = true;
}

const entrySize = Math.round(readFileSync(path.join(outdir, entryChunk), "utf8").length / 1024);
console.log(
  `entry chunk ${entryChunk}: ${entrySize} kB, ${lazy.length} lazy chunks (live machinery deferred)`,
);
rmSync(work, { recursive: true, force: true });
if (failed) process.exit(1);
console.log("bundle check ok: a page that mounts no video pulls no KVS/AWS/mqtt code");
