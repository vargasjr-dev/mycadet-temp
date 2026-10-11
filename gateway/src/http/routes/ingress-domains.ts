/**
 * Loopback-guarded recording of a tunnel's public URL.
 *
 *   POST /v1/ingress/domains — the CLI (its ngrok agent, today) tells the
 *   gateway the public URL its tunnel published; the gateway writes
 *   `ingress.publicBaseUrl` + `publicBaseUrlManagedBy: "tunnel"` in its own
 *   config via the same machinery its own tunnel uses, so both publishers
 *   record through one path and the gateway's existing loss handling clears
 *   it uniformly. Write-only: reads keep flowing through the config the
 *   gateway already serves. While we ship one bundle the gateway still hosts
 *   the ngrok-related logic; once the bundle splits, the gateway manages its
 *   own tunnel (mycadet.ai vs <assistant>.mycadet.bot) and this route is what
 *   the CLI-side publishers migrate onto.
 */

import { z } from "zod";

import { normalizeHttpPublicBaseUrlWithoutTrailingSlash } from "@mycadet/service-contracts/ingress";

import type { ConfigFileCache } from "../../config-file-cache.js";
import { writeManagedPublicBaseUrl } from "../../tunnel/client.js";
import {
  enforceLoopbackOnly,
  errorResponse,
  rejectBrowserOrigin,
} from "../loopback-guard.js";

const SaveIngressDomainRequestSchema = z.object({
  publicBaseUrl: z.string(),
});

export async function handleSaveIngressDomain(
  req: Request,
  clientIp: string,
  configFile: ConfigFileCache,
): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("method not allowed", {
      status: 405,
      headers: { Allow: "POST" },
    });
  }

  const guardError = enforceLoopbackOnly(req, clientIp, "ingress-domains");
  if (guardError) return guardError;
  const originError = rejectBrowserOrigin(req, clientIp, "ingress-domains");
  if (originError) return originError;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const parsed = SaveIngressDomainRequestSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse("BAD_REQUEST", "publicBaseUrl is required", 400);
  }
  const publicUrl = normalizeHttpPublicBaseUrlWithoutTrailingSlash(
    parsed.data.publicBaseUrl,
  );
  if (!publicUrl) {
    return errorResponse(
      "BAD_REQUEST",
      "publicBaseUrl must be an absolute http(s) URL",
      400,
    );
  }

  // No-op (no write) when the URL is already recorded as tunnel-managed.
  await writeManagedPublicBaseUrl(publicUrl, configFile);
  return Response.json({ ok: true });
}
