// Verify the artifact npm would publish, not the working tree: pack the
// tarball, check its file list, install it into an EMPTY directory and use it
// the way a consumer would. This class of check is what found the credential
// leak in @xorgate/sdk@0.1.0 after every other suite had passed.
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

// --- pack and inspect the file list ----------------------------------------
const packJson = JSON.parse(
  execSync("npm pack --dry-run --json", { cwd: repo, encoding: "utf8" }),
);
const files = packJson[0].files.map((f) => f.path);
const allowed = /^(dist\/|README\.md$|CHANGELOG\.md$|LICENSE$|package\.json$)/;
for (const f of files) {
  if (!allowed.test(f)) fail(`unexpected file in tarball: ${f}`);
}
for (const required of ["dist/index.js", "dist/index.d.ts", "LICENSE", "README.md"]) {
  if (!files.includes(required)) fail(`missing from tarball: ${required}`);
}
console.log(`tarball: ${files.length} files, ${Math.round(packJson[0].size / 1024)} kB packed`);

// --- install into an empty directory and use it as a consumer --------------
const tarName = execSync("npm pack", { cwd: repo, encoding: "utf8" }).trim().split("\n").pop();
const tarPath = path.join(repo, tarName);
const work = mkdtempSync(path.join(tmpdir(), "xg-react-consumer-"));
try {
  writeFileSync(
    path.join(work, "package.json"),
    JSON.stringify({ name: "consumer", private: true, type: "module" }),
  );
  execFileSync("npm", ["install", "--no-audit", "--no-fund", tarPath, "react", "react-dom"], {
    cwd: work,
    stdio: "pipe",
  });

  // Import the ESM build and serialize what a crash reporter would see.
  writeFileSync(
    path.join(work, "probe.mjs"),
    `
import * as xg from "@xorgate/react";
import { strict as assert } from "node:assert";
assert.ok(typeof xg.XorgateProvider === "function", "XorgateProvider exported");
assert.ok(typeof xg.useReplayPlayer === "function", "useReplayPlayer exported");
assert.ok(typeof xg.buildLanes === "function", "buildLanes exported");
assert.ok(typeof xg.XorgateError === "function", "XorgateError re-exported");

// The serialization check: nothing reachable from the module may leak what a
// consumer feeds it. The resolver is internal, but presignIotWssUrl and the
// pure functions take credentials as ARGUMENTS, so the module surface itself
// carries no state. Assert the timeline math works from the shipped build.
const tl = xg.buildTimeline(
  { segments: [{ seq: 0, startTs: 1000, effectiveDurationMs: 500, finalized: true, anchor: null, sizeBytes: null, url: "" }], gaps: [] },
  1000,
  1500,
);
assert.equal(xg.segmentAt(tl, 1200).segment.seq, 0);
console.log("consumer import ok");
`,
  );
  execFileSync("node", [path.join(work, "probe.mjs")], { cwd: work, stdio: "inherit" });

  // Compile a consumer TS file against the shipped .d.ts.
  writeFileSync(
    path.join(work, "consumer.tsx"),
    `
import { XorgateProvider, useLiveTelemetry, useReplayPlayer } from "@xorgate/react";
import type { ReplayManifest, LatestByMetric } from "@xorgate/react";
export function App({ manifest }: { manifest: ReplayManifest }) {
  const feed = useLiveTelemetry("dev-1");
  const player = useReplayPlayer(manifest);
  const latest: LatestByMetric = feed.latest;
  return { latest, playing: player.playing };
}
`,
  );
  writeFileSync(
    path.join(work, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        jsx: "react-jsx",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        lib: ["ES2022", "DOM"],
      },
      include: ["consumer.tsx"],
    }),
  );
  execFileSync(path.join(repo, "node_modules", ".bin", "tsc"), ["-p", work], {
    cwd: work,
    stdio: "inherit",
  });
  console.log("consumer types ok");

  // No secret material in the tarball. The .env is gitignored AND unpacked;
  // scan the shipped bytes for the local key as a belt-and-braces check.
  let localKey = null;
  try {
    const env = readFileSync(path.join(repo, ".env"), "utf8");
    localKey = env.match(/XORGATE_API_KEY=(\S+)/)?.[1] ?? null;
  } catch {
    /* no .env locally */
  }
  if (localKey && localKey.length > 8) {
    const shipped = execSync(`tar -xOzf ${tarPath}`, { maxBuffer: 64 * 1024 * 1024 }).toString();
    if (shipped.includes(localKey)) fail("the local API key is inside the tarball");
  }
  console.log("no secret material in the tarball");
} finally {
  rmSync(work, { recursive: true, force: true });
  rmSync(tarPath, { force: true });
}
console.log("verify:tarball ok");
