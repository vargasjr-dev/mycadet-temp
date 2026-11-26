/**
 * Provider webhook route declarations (dispatch-only, never in the spec):
 * unauthenticated by design — each provider's payload validates by its own
 * mechanism. Every handler is a plain function that reads the config,
 * credential, and config-file singletons at request time; importing this
 * module stays side-effect-free because nothing here runs at import.
 */

import {
  TWILIO_STATUS_WEBHOOK_PATH,
  TWILIO_VOICE_WEBHOOK_PATH,
} from "@mycadet/service-contracts/twilio-ingress";
import { getCredentials } from "../../credential-cache.js";
import { credentialKey } from "../../credential-key.js";
import { getLogger } from "../../logger.js";
import { handleTelegramWebhook } from "./telegram-webhook.js";
import { handleWhatsAppWebhook } from "./whatsapp-webhook.js";
import { handleEmailWebhook } from "./email-webhook.js";
import { handleTwilioVoiceWebhook } from "./twilio-voice-webhook.js";
import { handleTwilioStatusWebhook } from "./twilio-status-webhook.js";
import { handleTwilioVoiceVerifyCallback } from "./twilio-voice-verify-callback.js";
import { handleResendWebhook } from "./resend-webhook.js";
import { handleMailgunWebhook } from "./mailgun-webhook.js";
import { handleOAuthCallback } from "./oauth-callback.js";
import { handleMcpOAuthClientMetadata } from "./mcp-oauth-client-metadata.js";
import { handleInboundRegister } from "./inbound-register.js";
import { handleGuardianChannelCreate } from "./guardian-channel-create.js";
import { handlePluginWebhook } from "./plugin-webhook.js";
import { PLUGIN_WEBHOOK_PATH_PATTERN } from "../../channels/plugin-ingress.js";
import type { RouteDefinition } from "./types.js";

const log = getLogger("webhook-routes");

async function telegramConfigured(): Promise<boolean> {
  const [token, secret] = await Promise.all([
    getCredentials().get(credentialKey("telegram", "bot_token")),
    getCredentials().get(credentialKey("telegram", "webhook_secret")),
  ]);
  return !!(token && secret);
}

async function whatsappConfigured(): Promise<boolean> {
  const [phoneId, token] = await Promise.all([
    getCredentials().get(credentialKey("whatsapp", "phone_number_id")),
    getCredentials().get(credentialKey("whatsapp", "access_token")),
  ]);
  return !!(phoneId && token);
}

/** Reject when an integration isn't configured (503, logged). */
function notConfigured(name: string): Response {
  log.warn(
    { integration: name },
    `${name} integration not configured — rejecting request with 503`,
  );
  return Response.json(
    { error: `${name} integration not configured` },
    { status: 503 },
  );
}

export const ROUTES: RouteDefinition[] = [
  {
    path: "/webhooks/telegram",
    handler: async (req) =>
      (await telegramConfigured())
        ? handleTelegramWebhook(req)
        : notConfigured("Telegram"),
  },
  {
    path: TWILIO_VOICE_WEBHOOK_PATH,
    handler: handleTwilioVoiceWebhook,
  },
  {
    path: TWILIO_STATUS_WEBHOOK_PATH,
    handler: handleTwilioStatusWebhook,
  },
  {
    path: "/webhooks/twilio/voice-verify",
    handler: handleTwilioVoiceVerifyCallback,
  },
  {
    path: "/webhooks/whatsapp",
    handler: async (req) =>
      (await whatsappConfigured())
        ? handleWhatsAppWebhook(req)
        : notConfigured("WhatsApp"),
  },
  {
    path: "/webhooks/email",
    handler: handleEmailWebhook,
  },
  {
    path: "/webhooks/resend",
    handler: handleResendWebhook,
  },
  {
    path: "/webhooks/mailgun",
    handler: handleMailgunWebhook,
  },
  // Plugin-declared webhooks. Public like their neighbours above; what makes
  // them safe is that only a guardian-approved declaration creates one, every
  // other path here 404s, and each request is signature-checked. Any method —
  // the plugin's route module decides which verbs it answers. WebSocket-kind
  // declarations are upgraded in the pre-router, before this entry is reached.
  {
    path: PLUGIN_WEBHOOK_PATH_PATTERN,
    handler: (req, params) => handlePluginWebhook(req, params[0]!, params[1]!),
  },
  {
    // BYO provider registration (auto-verify guardian email)
    path: "/inbound/register",
    method: "post",
    auth: "edge-scoped",
    scope: "internal.write",
    handler: handleInboundRegister,
  },
  {
    // Guardian channel creation (platform auto-verify)
    path: "/contacts/guardian/channel",
    method: "post",
    auth: "edge-guardian",
    handler: handleGuardianChannelCreate,
  },
  {
    path: "/webhooks/oauth/callback",
    method: "get",
    auth: "track-failures",
    trackFailureStatuses: [400],
    handler: handleOAuthCallback,
  },
  {
    path: "/oauth/client-metadata.json",
    method: "get",
    handler: handleMcpOAuthClientMetadata,
  },
];
