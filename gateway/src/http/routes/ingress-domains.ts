/**
 * Guardian-authed recording of a public base URL.
 *
 *   POST /v1/ingress/domains — a publisher tells the gateway the public
 *   URL its users' browsers dial; the gateway writes `ingress.publicBaseUrl`
 *   + `publicBaseUrlManagedBy` in its own config via the same machinery its
 *   own tunnel uses, so all publishers record through one path. Two
 *   publishers today: the CLI's tunnel agent (`managedBy: "tunnel"`, the
 *   default — while we ship one bundle the gateway still hosts the
 *   ngrok-related logic) and hatch, whose post-lease save records the
 *   loopback port map (`managedBy: "hatch"`, set by the caller) so the
 *   pairing mint never has to fall back to the internal bind URL. The tag
 *   is the ownership marker: the tunnel's reconcile and loss handling only
 *   touch `tunnel`-tagged URLs, so a dead tunnel cannot clear a
 *   hatch-recorded one, and a live tunnel's publication supersedes it.
 *   Write-only: reads keep flowing through the config the gateway already
 *   serves. Once the bundle splits, the gateway manages its own tunnel
 *   (mycadet.ai vs <assistant>.mycadet.bot) and this route is what the
 *   CLI-side publishers migrate onto.
 */

import { z } from "zod";

import { normalizeHttpPublicBaseUrlWithoutTrailingSlash } from "@mycadet/service-contracts/ingress";

import {
  getConfigFileCache,
  type ConfigFileCache,
} from "../../config-file-cache.js";
import { writeManagedPublicBaseUrl } from "../../tunnel/client.js";
import { errorResponse, rejectBrowserOrigin } from "../loopback-guard.js";
import type { RouteDefinition } from "./types.js";

const SaveIngressDomainRequestSchema = z.object({
  publicBaseUrl: z.string(),
  // Who is publishing — the ownership marker the tunnel's reconcile keys
  // on. Lowercase kebab words; the default keeps the existing tunnel
  // callers unchanged.
  managedBy: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,31}$/)
    .optional(),
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

  // No-op (no write) when the URL is already recorded under this tag.
  await writeManagedPublicBaseUrl(
    publicUrl,
    configFile,
    parsed.data.managedBy ?? "tunnel",
  );
  return Response.json({ ok: true });
}

export const ROUTES: RouteDefinition[] = [
  {
    // Ingress domain recording (guardian bearer, loopback fallback)
    path: "/ingress/domains",
    method: "post",
    auth: "edge-guardian",
    handler: (req, _params, getClientIp) =>
      handleSaveIngressDomain(req, getClientIp(), getConfigFileCache()),
  },
];
