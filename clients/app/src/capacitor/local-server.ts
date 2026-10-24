import { readLockfile } from "@mycadet/local-mode";

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
  const lockfile = readLockfile();
  const tunnelUrl = lockfile.tunnel?.publicUrl;
  if (isUsableBaseUrl(tunnelUrl)) {
    return tunnelUrl;
  }
  const port = lockfile.app?.port;
  if (typeof port === "number") {
    return `http://127.0.0.1:${port}`;
  }
  return undefined;
}

function isUsableBaseUrl(url: string | undefined): boolean {
  if (!url) {
    return false;
  }
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}
