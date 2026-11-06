import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getWorkspaceDir } from "../paths.js";
import { loadConfig } from "../config.js";
import { getLogger } from "../logger.js";

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
  console.log("parsePublicBaseUrl", value);
  const logger = getLogger("parsePublicBaseUrl");
  logger.info("parsePublicBaseUrl | " + value);
  if (!value.trim()) {
    return null;
  }
  try {
    const url = new URL(value);
    logger.info("protocol | " + url.protocol + " | " + url.host);

    console.log("protocol", url.protocol, url.host);

    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (!url.host) return null;
    const pathPrefix = url.pathname.replace(/\/+$/, "");
    return `${url.origin}${pathPrefix}`;
  } catch {
    return null;
  }
}

/** The ingress URL recorded in the Cadet's workspace, defaulting to localhost */
export function readSavedIngressPublicBaseUrl(): string {
  const config = JSON.parse(
    readFileSync(join(getWorkspaceDir(), "config.json"), "utf-8"),
  ) as Record<string, unknown>;
  const ingress = config.ingress as Record<string, unknown> | undefined;
  const url = ingress?.publicBaseUrl;
  if (typeof url === "string") return url.trim();
  return `http://127.0.0.1:${loadConfig().port}`;
}
