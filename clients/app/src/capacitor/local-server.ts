import { readFileSync } from "node:fs";
import { join } from "node:path";

import { resolveLockfilePaths, resolveRuntimeDir } from "@mycadet/local-mode";
import { LockfileAssistantSchema } from "@mycadet/local-mode/contract";

/**
 * The local build's control-plane base: the running cadet's tunnel URL when
 * one is up (the workspace `ingress.publicBaseUrl` record the tunnel
 * providers write), else the app server's loopback port (the lockfile
 * entry's `resources.daemonPort`). A loopback base is reachable from the
 * iOS simulator only — a device's `127.0.0.1` is the phone itself — so a
 * device build wants a tunnel up before it stamps. `undefined` when
 * nothing discoverable carries a usable address, leaving the stamp on the
 * seed's dev-stack default.
 */
export function resolveLocalServerUrl(
  env: Record<string, string | undefined> = process.env,
  read: (path: string) => string = (path) => readFileSync(path, "utf-8"),
): string | undefined {
  return tunnelUrl(env, read) ?? loopbackUrl(env, read);
}

/**
 * The tunnel URL: the workspace config's `ingress.publicBaseUrl` — the same
 * record the pair flow reads and the tunnel providers (re)write on wake.
 */
function tunnelUrl(
  env: Record<string, string | undefined>,
  read: (path: string) => string,
): string | undefined {
  const workspaceDir =
    env.CADET_WORKSPACE_DIR?.trim() || join(resolveRuntimeDir(env), "workspace");
  let raw: string;
  try {
    raw = read(join(workspaceDir, "config.json"));
  } catch {
    return undefined;
  }
  let config: { ingress?: { publicBaseUrl?: unknown } };
  try {
    config = JSON.parse(raw) as { ingress?: { publicBaseUrl?: unknown } };
  } catch {
    return undefined;
  }
  const url = config.ingress?.publicBaseUrl;
  return typeof url === "string" && isUsableBaseUrl(url) ? url : undefined;
}

/**
 * The loopback app-server port: the first local lockfile entry whose
 * runtime resources record a daemon port.
 */
function loopbackUrl(
  env: Record<string, string | undefined>,
  read: (path: string) => string,
): string | undefined {
  for (const path of resolveLockfilePaths(env)) {
    let raw: string;
    try {
      raw = read(path);
    } catch {
      continue;
    }
    let lockfile: { assistants?: unknown };
    try {
      lockfile = JSON.parse(raw) as { assistants?: unknown };
    } catch {
      continue;
    }
    if (!Array.isArray(lockfile.assistants)) {
      continue;
    }
    for (const entry of lockfile.assistants) {
      const parsed = LockfileAssistantSchema.safeParse(entry);
      if (!parsed.success || parsed.data.cloud !== "local") {
        continue;
      }
      const port = parsed.data.resources?.daemonPort;
      if (typeof port === "number") {
        return `http://127.0.0.1:${port}`;
      }
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
