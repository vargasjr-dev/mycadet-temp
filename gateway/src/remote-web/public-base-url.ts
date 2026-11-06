import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

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

/**
 * The gateway's own minimal read of the workspace config. This is
 * deliberately a gateway-side schema rather than the workspace config's
 * shared definition: the saved ingress URL is expected to move out of the
 * workspace config and live gateway-side entirely, so the gateway describes
 * only the little shape it reads and shares no field literals with the
 * workspace config's schema.
 */
const SavedIngressConfigSchema = z.object({
  ingress: z
    .object({
      publicBaseUrl: z.string(),
    })
    .optional(),
});

/** The ingress URL recorded in the Cadet's workspace, defaulting to localhost */
export function readSavedIngressPublicBaseUrl(): string {
  try {
    const raw = readFileSync(join(getWorkspaceDir(), "config.json"), "utf-8");
    const config = SavedIngressConfigSchema.parse(JSON.parse(raw));
    const url = config.ingress?.publicBaseUrl;
    if (url?.trim()) return url;
  } catch {
    // No workspace config (or an unreadable one) — the local default below
    // is the answer for a local assistant.
  }
  return `http://127.0.0.1:${loadConfig().port}`;
}
}

