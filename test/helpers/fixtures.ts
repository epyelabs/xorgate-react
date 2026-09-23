import { readFileSync as read } from "node:fs";
import { gunzipSync as gunzip } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Test-only access to the committed artifact fixtures. The gzip here is
 * `node:zlib`, never the package: a browser's `fetch()` inflates these
 * objects itself because they are served with `Content-Encoding: gzip`.
 */
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "telemetry-artifacts");

export function readFileSync(name: string): Buffer {
  return read(path.join(dir, name));
}

export const gunzipSync = gunzip;
