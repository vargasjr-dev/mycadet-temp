/**
 * Provider webhook route declarations (dispatch-only — never published in
 * the spec). These endpoints are unauthenticated by design: each provider's
 * payload is validated by its own mechanism (signature, HMAC, dedup cache),
 * not by gateway auth middleware.
 *
 * Handlers are built once on first request from the process-wide config,
 * credential, and config-file singletons; module import stays
 * side-effect-free for the OpenAPI generation script. The dedup caches are
 * exported because the gateway process owns their lifecycle (cleanup
 * timers, credential-change resets).
 */

import {
  TWILIO_STATUS_WEBHOOK_PATH,
  TWILIO_VOICE_WEBHOOK_PATH,
} from "@mycadet/service-contracts/twilio-ingress";
import { getConfig } from "../../config.js";
import { getCredentials } from "../../credential-cache.js";
import { getConfigFileCache } from "../../config-file-cache.js";
import { credentialKey } from "../../credential-key.js";
import { getLogger } from "../../logger.js";
import { createTelegramWebhookHandler } from "./telegram-webhook.js";
import { createWhatsAppWebhookHandler } from "./whatsapp-webhook.js";
import { createEmailWebhookHandler } from "./email-webhook.js";
import { createTwilioVoiceWebhookHandler } from "./twilio-voice-webhook.js";
import { createTwilioStatusWebhookHandler } from "./twilio-status-webhook.js";
import { createTwilioVoiceVerifyCallbackHandler } from "./twilio-voice-verify-callback.js";
import { createResendWebhookHandler } from "./resend-webhook.js";
import { createMailgunWebhookHandler } from "./mailgun-webhook.js";
import { createOAuthCallbackHandler } from "./oauth-callback.js";
import { createMcpOAuthClientMetadataHandler } from "./mcp-oauth-client-metadata.js";
import { createInboundRegisterHandler } from "./inbound-register.js";
import { createGuardianChannelHandler } from "./guardian-channel-create.js";
import { createPluginWebhookHandler } from "./plugin-webhook.js";
import { PLUGIN_WEBHOOK_PATH_PATTERN } from "../../channels/plugin-ingress.js";
import { resolveCachedPluginIngress } from "../../channels/plugin-ingress-approvals.js";
import type { RouteDefinition } from "./types.js";

/** The webhook dedup caches the gateway process lifecycle-manages. */
export type WebhookDedupCaches = {
  telegramDedupCache: ReturnType<
    typeof createTelegramWebhookHandler
  >["dedupCache"];
  whatsappDedupCache: ReturnType<
    typeof createWhatsAppWebhookHandler
  >["dedupCache"];
  emailDedupCache: ReturnType<typeof createEmailWebhookHandler>["dedupCache"];
};

const log = getLogger("webhook-routes");

interface WebhookHandlers {
  telegram: ReturnType<typeof createTelegramWebhookHandler>;
  whatsapp: ReturnType<typeof createWhatsAppWebhookHandler>;
  email: ReturnType<typeof createEmailWebhookHandler>;
  resend: ReturnType<typeof createResendWebhookHandler>;
  mailgun: ReturnType<typeof createMailgunWebhookHandler>;
  twilioVoice: ReturnType<typeof createTwilioVoiceWebhookHandler>;
  twilioStatus: ReturnType<typeof createTwilioStatusWebhookHandler>;
  twilioVerify: ReturnType<typeof createTwilioVoiceVerifyCallbackHandler>;
  plugin: ReturnType<typeof createPluginWebhookHandler>;
  oauthCallback: ReturnType<typeof createOAuthCallbackHandler>;
  mcpMetadata: ReturnType<typeof createMcpOAuthClientMetadataHandler>;
  inboundRegister: ReturnType<typeof createInboundRegisterHandler>;
  guardianChannel: ReturnType<typeof createGuardianChannelHandler>;
}

let built: WebhookHandlers | undefined;

/** Built on first request — module import stays side-effect-free. */
function handlers(): WebhookHandlers {
  return (built ??= (() => {
    const config = getConfig();
    const credentials = getCredentials();
    const configFile = getConfigFileCache();
    const validationCaches = { credentials, configFile };
    return {
      telegram: createTelegramWebhookHandler(config, validationCaches),
      whatsapp: createWhatsAppWebhookHandler(config, validationCaches),
      email: createEmailWebhookHandler(config, validationCaches),
      resend: createResendWebhookHandler(config, validationCaches),
      mailgun: createMailgunWebhookHandler(config, validationCaches),
      twilioVoice: createTwilioVoiceWebhookHandler(config, validationCaches),
      twilioStatus: createTwilioStatusWebhookHandler(config, validationCaches),
      twilioVerify: createTwilioVoiceVerifyCallbackHandler(
        config,
        validationCaches,
      ),
      plugin: createPluginWebhookHandler({
        config,
        resolve: resolveCachedPluginIngress,
        credentials,
        // HMAC payloads can sign the public request URL. Read through the cache
        // so a tunnel registering a public base is picked up without a restart.
        ingressPublicBaseUrl: () =>
          configFile.getString("ingress", "publicBaseUrl"),
      }),
      oauthCallback: createOAuthCallbackHandler(config),
      mcpMetadata: createMcpOAuthClientMetadataHandler(configFile),
      inboundRegister: createInboundRegisterHandler(config, credentials),
      guardianChannel: createGuardianChannelHandler(),
    };
  })());
}

/** The dedup caches, for the gateway process's lifecycle management. */
export function webhookDedupCaches(): WebhookDedupCaches {
  const h = handlers();
  return {
    telegramDedupCache: h.telegram.dedupCache,
    whatsappDedupCache: h.whatsapp.dedupCache,
    emailDedupCache: h.email.dedupCache,
  };
}

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
        ? handlers().telegram.handler(req)
        : notConfigured("Telegram"),
  },
  {
    path: TWILIO_VOICE_WEBHOOK_PATH,
    handler: (req) => handlers().twilioVoice(req),
  },
  {
    path: TWILIO_STATUS_WEBHOOK_PATH,
    handler: (req) => handlers().twilioStatus(req),
  },
  {
    path: "/webhooks/twilio/voice-verify",
    handler: (req) => handlers().twilioVerify(req),
  },
  {
    path: "/webhooks/whatsapp",
    handler: async (req) =>
      (await whatsappConfigured())
        ? handlers().whatsapp.handler(req)
        : notConfigured("WhatsApp"),
  },
  {
    path: "/webhooks/email",
    handler: (req) => handlers().email.handler(req),
  },
  {
    path: "/webhooks/resend",
    handler: (req) => handlers().resend.handler(req),
  },
  {
    path: "/webhooks/mailgun",
    handler: (req) => handlers().mailgun.handler(req),
  },
  // Plugin-declared webhooks. Public like their neighbours above; what makes
  // them safe is that only a guardian-approved declaration creates one, every
  // other path here 404s, and each request is signature-checked. Any method —
  // the plugin's route module decides which verbs it answers. WebSocket-kind
  // declarations are upgraded in the pre-router, before this entry is reached.
  {
    path: PLUGIN_WEBHOOK_PATH_PATTERN,
    handler: (req, params) =>
      handlers().plugin(req, params[0]!, params[1]!),
  },
  {
    // BYO provider registration (auto-verify guardian email)
    path: "/inbound/register",
    method: "post",
    auth: "edge-scoped",
    scope: "internal.write",
    handler: (req) => handlers().inboundRegister(req),
  },
  {
    // Guardian channel creation (platform auto-verify)
    path: "/contacts/guardian/channel",
    method: "post",
    auth: "edge-guardian",
    handler: (req) => handlers().guardianChannel(req),
  },
  {
    path: "/webhooks/oauth/callback",
    method: "get",
    auth: "track-failures",
    trackFailureStatuses: [400],
    handler: (req) => handlers().oauthCallback(req),
  },
  {
    path: "/oauth/client-metadata.json",
    method: "get",
    handler: () => handlers().mcpMetadata(),
  },
];
