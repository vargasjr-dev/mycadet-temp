/**
 * Route handlers for authentication status.
 *
 * GET /v1/auth/info — return platform identity and authentication status
 */

import { z } from "zod";

import {
  getCloudAssistantId,
  getCloudBaseUrl,
  getCloudOrganizationId,
  getCloudUserId,
} from "../../config/env.js";
import { resolveCloudProxyContext } from "../../providers/cloud-proxy/context.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

interface AuthInfoResult {
  cloudUrl: string | null;
  assistantId: string | null;
  organizationId: string | null;
  userId: string | null;
  authenticated: boolean;
  message?: string;
}

async function handleAuthInfo(
  _args: RouteHandlerArgs,
): Promise<AuthInfoResult> {
  const ctx = await resolveCloudProxyContext();

  const cloudUrl = getCloudBaseUrl();
  const assistantId = getCloudAssistantId();
  const organizationId = getCloudOrganizationId();
  const userId = getCloudUserId();
  const authenticated = ctx.enabled;

  const result: AuthInfoResult = {
    cloudUrl: cloudUrl || null,
    assistantId: assistantId || null,
    organizationId: organizationId || null,
    userId: userId || null,
    authenticated,
  };

  if (!authenticated) {
    result.message = !cloudUrl
      ? "Platform URL not configured. Run assistant config set platform.baseUrl <url>"
      : "Assistant API key not found. Store one with: assistant keys set credential/cadet/assistant_api_key <key>";
  }

  return result;
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "auth_info",
    endpoint: "auth/info",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get authentication status",
    description:
      "Returns platform identity and authentication status for this assistant.",
    tags: ["auth"],
    responseBody: z.object({
      cloudUrl: z.string().nullable(),
      assistantId: z.string().nullable(),
      organizationId: z.string().nullable(),
      userId: z.string().nullable(),
      authenticated: z.boolean(),
      message: z.string().optional(),
    }),
    handler: handleAuthInfo,
  },
];
