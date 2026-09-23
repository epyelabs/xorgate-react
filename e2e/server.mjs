// The e2e harness server: the ONLY holder of the xorgate credential, playing
// the part of a consumer's backend (Alocate's shape). The browser gets vended
// credentials, channel metadata, a manifest object and proxied telemetry;
// never the credential.
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";

/**
 * `.env` (when present) overlaid with any `XORGATE_*` variable from the
 * process environment, so a one-off run can point the suite elsewhere
 * without editing the file. `XORGATE_ORG_ID` is always required; the
 * credential is `XORGATE_API_KEY`, or a browser login when
 * `XORGATE_AUTH_MODE=browser-login` (run.mjs captures the token in memory).
 */
export function loadEnv(envPath) {
  const env = existsSync(envPath)
    ? Object.fromEntries(
        readFileSync(envPath, "utf8")
          .split("\n")
          .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
          .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
      )
    : {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("XORGATE_") && v !== undefined && v !== "") env[k] = v;
  }
  const required = ["XORGATE_ORG_ID"];
  if (env.XORGATE_AUTH_MODE !== "browser-login") required.push("XORGATE_API_KEY");
  const missing = required.filter((k) => !env[k]);
  if (missing.length) throw new Error(`missing in ${envPath} / environment: ${missing.join(", ")}`);
  return env;
}

/**
 * `authorization()` returns the bearer value for every upstream call: the
 * API key from the env, or the session token a browser login captured. It is
 * a function so the token never sits in a config object that could be
 * logged or serialized.
 */
export async function startServer({ env, baseUrl, workspaceId, bundle, testConfig, authorization }) {
  const bearer = authorization ?? (() => env.XORGATE_API_KEY);
  const api = async (path, init = {}) => {
    const res = await fetch(`${baseUrl}/v1${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${bearer()}`,
        "X-Organization-Id": env.XORGATE_ORG_ID,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(`${path} -> ${res.status}: ${JSON.stringify(body?.error ?? body)}`);
    }
    return body;
  };

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url, "http://localhost");
      try {
        if (url.pathname === "/") {
          res.setHeader("Content-Type", "text/html");
          res.end(
            `<!doctype html><meta charset="utf-8"><title>xorgate-react e2e</title>` +
              `<div id="root"></div>` +
              `<script>window.__TEST = ${JSON.stringify(testConfig())};</script>` +
              `<script>${bundle()}</script>`,
          );
          return;
        }
        if (url.pathname === "/vend" && req.method === "POST") {
          const vend = await api("/auth/live-credentials", {
            method: "POST",
            body: JSON.stringify({ workspaceId }),
          });
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(vend));
          return;
        }
        if (url.pathname === "/telemetry") {
          const deviceId = url.searchParams.get("deviceId");
          const qs = new URLSearchParams();
          for (const key of ["from", "to", "metric", "interval"]) {
            const v = url.searchParams.get(key);
            if (v !== null) qs.set(key, v);
          }
          const body = await api(`/devices/${deviceId}/telemetry?${qs}`);
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(body));
          return;
        }
        res.statusCode = 404;
        res.end("not found");
      } catch (err) {
        res.statusCode = 500;
        res.end(String(err?.message ?? err));
      }
    })();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    api,
    url: `http://127.0.0.1:${server.address().port}/`,
    close: () => server.close(),
  };
}
