import { readFileSync } from "node:fs";

import { parseLockfile, resolveLockfilePaths } from "@mycadet/local-mode";

/**
 * The local build's control-plane base, read from the lockfile alone: the
 * auto-tunnel's recorded `publicUrl` when one is up, else the app server
 * edge's loopback port. A loopback base is reachable from the iOS simulator
 * only — a device's `127.0.0.1` is the phone itself — so a device build
 * wants a tunnel up before it stamps. `undefined` when neither record
 * carries a usable address, leaving the stamp on the seed's dev-stack
 * default.
 *
 * The assistants play no role in this resolution — the capacitor app shell
 * only deals with the app server — and the CLI's workspace config is never
 * touched: the lockfile is the single home for edge state.
 */
export function resolveLocalServerUrl(): string | undefined {
  for (const path of resolveLockfilePaths(process.env)) {
    let lockfile;
    try {
      lockfile = parseLockfile(JSON.parse(readFileSync(path, "utf-8")));
    } catch {
      continue;
    }
    const tunnelUrl = lockfile.tunnel?.publicUrl;
    if (tunnelUrl && isUsableBaseUrl(tunnelUrl)) {
      return tunnelUrl;
    }
    const port = lockfile.app?.port;
    if (typeof port === "number") {
      return `http://127.0.0.1:${port}`;
    }
  }
  return undefined;
}

function isUsableBaseUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}
