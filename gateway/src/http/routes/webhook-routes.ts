/**
 * Provider webhook route declarations (dispatch-only — never published in
 * the spec). These endpoints are unauthenticated by design: each provider's
 * payload is validated by its own mechanism (signature, HMAC, dedup cache),
 * not by gateway auth middleware.
 *
 * Handlers are built once at server startup via `initWebhookRoutes`; the
 * dedup caches are returned to the caller because the gateway process owns
 * their lifecycle (cleanup timers, credential-change resets).
 */

import {
  TWILIO_STATUS_WEBHOOK_PATH,
  TWILIO_VOICE_WEBHOOK_PATH,
} from "@mycadet/service-contracts/twilio-ingress";
import { getLogger } from "../../logger.js";
import { createTelegramWebhookHandler } from "./telegram-webhook.js";
import { createTwilioVoiceWebhookHandler } from "./twilio-voice-webhook.js";
import { createTwilioStatusWebhookHandler } from "./twilio-status-webhook.js";
import { createTwilioVoiceVerifyCallbackHandler } from "./twilio-voice-verify-callback.js";
import { createWhatsAppWebhookHandler } from "./whatsapp-webhook.js";
import { createEmailWebhookHandler } from "./email-webhook.js";
import { createMailgunWebhookHandler } from "./mailgun-webhook.js";
import { createResendWebhookHandler } from "./resend-webhook.js";
import { createOAuthCallbackHandler } from "./oauth-callback.js";
import { createMcpOAuthClientMetadataHandler } from "./mcp-oauth-client-metadata.js";
import { createInboundRegisterHandler } from "./inbound-register.js";
import { createGuardianChannelHandler } from "./guardian-channel-create.js";
import { createPluginWebhookHandler } from "./plugin-webhook.js";
import { PLUGIN_WEBHOOK_PATH_PATTERN } from "../../channels/plugin-ingress.js";
import { resolveCachedPluginIngress } from "../../channels/plugin-ingress-approvals.js";
import type { GatewayConfig } from "../../config.js";
import type { CredentialCache } from "../../credential-cache.js";
import type { ConfigFileCache } from "../../config-file-cache.js";
import type { GatewayRouteDefinition } from "./types.js";
import { lazyRef } from "./lazy.js";

export interface WebhookRoutesDeps {
  config: GatewayConfig;
  credentials: CredentialCache;
  configFile: ConfigFileCache;
  isTelegramConfigured: () => boolean;
  isWhatsAppConfigured: () => boolean;
}

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
const deps = lazyRef<WebhookRoutesDeps>(
  "webhook routes used before initialization",
);

/** Reject when an integration isn't configured (503, logged). */
function requireConfigured(
  check: () => boolean,
  name: string,
): () => Response | null {
  return () => {
    if (!check()) {
      log.warn(
        { integration: name },
        `${name} integration not configured — rejecting request with 503`,
      );
      return Response.json(
        { error: `${name} integration not configured` },
        { status: 503 },
      );
    }
    return null;
  };
}

export function initWebhookRoutes(
  injected: WebhookRoutesDeps,
): WebhookDedupCaches {
  deps.set(injected);
  const { config, credentials, configFile } = injected;
  const validationCaches = { credentials, configFile };
  const telegram = createTelegramWebhookHandler(config, validationCaches);
  const whatsapp = createWhatsAppWebhookHandler(config, validationCaches);
  const email = createEmailWebhookHandler(config, validationCaches);
  webhookHandler.set(telegram.handler);
  whatsappHandler.set(whatsapp.handler);
  emailHandler.set(email.handler);
  resendHandler.set(
    createResendWebhookHandler(config, validationCaches).handler,
  );
  mailgunHandler.set(
    createMailgunWebhookHandler(config, validationCaches).handler,
  );
  twilioVoiceHandler.set(
    createTwilioVoiceWebhookHandler(config, validationCaches),
  );
  twilioStatusHandler.set(
    createTwilioStatusWebhookHandler(config, validationCaches),
  );
  twilioVerifyHandler.set(
    createTwilioVoiceVerifyCallbackHandler(config, validationCaches),
  );
  pluginHandler.set(
    createPluginWebhookHandler({
      config,
      resolve: resolveCachedPluginIngress,
      credentials,
      // HMAC payloads can sign the public request URL. Read through the cache
      // so a tunnel registering a public base is picked up without a restart.
      ingressPublicBaseUrl: () =>
        configFile.getString("ingress", "publicBaseUrl"),
    }),
  );
  oauthCallbackHandler.set(createOAuthCallbackHandler(config));
  mcpMetadataHandler.set(createMcpOAuthClientMetadataHandler(configFile));
  inboundRegisterHandler.set(createInboundRegisterHandler(config, credentials));
  guardianChannelHandler.set(createGuardianChannelHandler());
  return {
    telegramDedupCache: telegram.dedupCache,
    whatsappDedupCache: whatsapp.dedupCache,
    emailDedupCache: email.dedupCache,
  };
}

const webhookHandler = lazyRef<
  ReturnType<typeof createTelegramWebhookHandler>["handler"]
>("Telegram webhook handler");
const whatsappHandler = lazyRef<
  ReturnType<typeof createWhatsAppWebhookHandler>["handler"]
>("WhatsApp webhook handler");
const emailHandler = lazyRef<
  ReturnType<typeof createEmailWebhookHandler>["handler"]
>("Email webhook handler");
const resendHandler = lazyRef<
  ReturnType<typeof createResendWebhookHandler>["handler"]
>("Resend webhook handler");
const mailgunHandler = lazyRef<
  ReturnType<typeof createMailgunWebhookHandler>["handler"]
>("Mailgun webhook handler");
const twilioVoiceHandler = lazyRef<
  ReturnType<typeof createTwilioVoiceWebhookHandler>
>("Twilio voice webhook handler");
const twilioStatusHandler = lazyRef<
  ReturnType<typeof createTwilioStatusWebhookHandler>
>("Twilio status webhook handler");
const twilioVerifyHandler = lazyRef<
  ReturnType<typeof createTwilioVoiceVerifyCallbackHandler>
>("Twilio verify webhook handler");
const pluginHandler = lazyRef<ReturnType<typeof createPluginWebhookHandler>>(
  "Plugin webhook handler",
);
const oauthCallbackHandler = lazyRef<
  ReturnType<typeof createOAuthCallbackHandler>
>("OAuth callback handler");
const mcpMetadataHandler = lazyRef<
  ReturnType<typeof createMcpOAuthClientMetadataHandler>
>("MCP OAuth metadata handler");
const inboundRegisterHandler = lazyRef<
  ReturnType<typeof createInboundRegisterHandler>
>("Inbound register handler");
const guardianChannelHandler = lazyRef<
  ReturnType<typeof createGuardianChannelHandler>
>("Guardian channel handler");

export const ROUTES: GatewayRouteDefinition[] = [
  {
    path: "/webhooks/telegram",
    precondition: () =>
      requireConfigured(deps.get().isTelegramConfigured, "Telegram")(),
    handler: (req) => webhookHandler.get()(req),
  },
  {
    path: TWILIO_VOICE_WEBHOOK_PATH,
    handler: (req) => twilioVoiceHandler.get()(req),
  },
  {
    path: TWILIO_STATUS_WEBHOOK_PATH,
    handler: (req) => twilioStatusHandler.get()(req),
  },
  {
    path: "/webhooks/twilio/voice-verify",
    handler: (req) => twilioVerifyHandler.get()(req),
  },
  {
    path: "/webhooks/whatsapp",
    precondition: () =>
      requireConfigured(deps.get().isWhatsAppConfigured, "WhatsApp")(),
    handler: (req) => whatsappHandler.get()(req),
  },
  {
    path: "/webhooks/email",
    handler: (req) => emailHandler.get()(req),
  },
  {
    path: "/webhooks/resend",
    handler: (req) => resendHandler.get()(req),
  },
  {
    path: "/webhooks/mailgun",
    handler: (req) => mailgunHandler.get()(req),
  },
  // Plugin-declared webhooks. Public like their neighbours above; what makes
  // them safe is that only a guardian-approved declaration creates one, every
  // other path here 404s, and each request is signature-checked. Any method —
  // the plugin's route module decides which verbs it answers. WebSocket-kind
  // declarations are upgraded in the pre-router, before this entry is reached.
  {
    path: PLUGIN_WEBHOOK_PATH_PATTERN,
    handler: (req, params) => pluginHandler.get()(req, params[0]!, params[1]!),
  },
  {
    // BYO provider registration (auto-verify guardian email)
    path: "/inbound/register",
    method: "post",
    auth: "edge-scoped",
    scope: "internal.write",
    handler: (req) => inboundRegisterHandler.get()(req),
  },
  {
    // Guardian channel creation (platform auto-verify)
    path: "/contacts/guardian/channel",
    method: "post",
    auth: "edge-guardian",
    handler: (req) => guardianChannelHandler.get()(req),
  },
  {
    path: "/webhooks/oauth/callback",
    method: "get",
    auth: "track-failures",
    trackFailureStatuses: [400],
    handler: (req) => oauthCallbackHandler.get()(req),
  },
  {
    path: "/oauth/client-metadata.json",
    method: "get",
    handler: () => mcpMetadataHandler.get()(),
  },
];
