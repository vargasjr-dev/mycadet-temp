import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getWorkspaceDir } from "../paths.js";

/**
 * Shared public-base-URL handling for the remote-web pairing flow — the
 * HTTP challenge route and the direct pairing mint (`gateway pairing mint`)
 * validate and self-source the URL with the exact same rules.
 */

/**
 * Normalize an advertised base URL to `origin + trailing-slash-stripped path`,
 * or null when the value is empty, unparseable, non-http(s), or hostless.
 */
export function parsePublicBaseUrl(value: string): string | null {
  if (!value.trim()) {
    return null;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (!url.host) return null;
    const pathPrefix = url.pathname.replace(/\/+$/, "");
    return `${url.origin}${pathPrefix}`;
  } catch {
    return null;
  }
}

/** The ingress URL recorded in this gateway's own workspace, or null. */
export function readSavedIngressPublicBaseUrl(): string | null {
  try {
    const config = JSON.parse(
      readFileSync(join(getWorkspaceDir(), "config.json"), "utf-8"),
    ) as Record<string, unknown>;
    const ingress = config.ingress as Record<string, unknown> | undefined;
    const url = ingress?.publicBaseUrl;
    return typeof url === "string" && url.trim() ? url : null;
  } catch {
    return null;
  }
}
