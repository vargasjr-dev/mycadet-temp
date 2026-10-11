import {
  INGRESS_ASSISTANT_ID_KEY,
  INGRESS_LAST_TUNNEL_KEY,
  INGRESS_PAIRING_TUNNEL_KEY,
  TUNNEL_PROVIDERS,
} from "@mycadet/service-contracts/ingress";
import { z } from "zod";

/**
 * A recorded tunnel under `ingress.lastTunnel` / `ingress.pairingTunnel`.
 * The CLI writes these records (validated by `parseTunnelRecord` in
 * service-contracts — the single source for the key names, the provider
 * allowlist, and record validation); the schema carries them so schema-
 * canonical config writes preserve live tunnel state instead of dropping it.
 */
const TunnelRecordSchema = z.object({
  provider: z.enum(TUNNEL_PROVIDERS),
  publicBaseUrl: z.string(),
});

function emptyOrAbsoluteHttpUrl(fieldPath: string) {
  return z
    .string({ error: `${fieldPath} must be a string` })
    .refine(
      (val) => val === "" || /^https?:\/\//i.test(val),
      `${fieldPath} must be an absolute URL starting with http:// or https://`,
    );
}

const IngressWebhookConfigSchema = z
  .object({
    secret: z
      .string({ error: "ingress.webhook.secret must be a string" })
      .default("")
      .describe("Shared secret for HMAC webhook signature verification"),
    timeoutMs: z
      .number({ error: "ingress.webhook.timeoutMs must be a number" })
      .int("ingress.webhook.timeoutMs must be an integer")
      .positive("ingress.webhook.timeoutMs must be a positive integer")
      .default(30_000)
      .describe(
        "Timeout for outgoing webhook delivery requests in milliseconds",
      ),
    maxRetries: z
      .number({ error: "ingress.webhook.maxRetries must be a number" })
      .int("ingress.webhook.maxRetries must be an integer")
      .nonnegative("ingress.webhook.maxRetries must be a non-negative integer")
      .default(2)
      .describe(
        "Maximum number of retry attempts for failed webhook deliveries",
      ),
    initialBackoffMs: z
      .number({ error: "ingress.webhook.initialBackoffMs must be a number" })
      .int("ingress.webhook.initialBackoffMs must be an integer")
      .positive("ingress.webhook.initialBackoffMs must be a positive integer")
      .default(500)
      .describe(
        "Initial backoff delay between webhook retries in milliseconds",
      ),
    maxPayloadBytes: z
      .number({ error: "ingress.webhook.maxPayloadBytes must be a number" })
      .int("ingress.webhook.maxPayloadBytes must be an integer")
      .positive("ingress.webhook.maxPayloadBytes must be a positive integer")
      .default(1_048_576)
      .describe("Maximum allowed webhook payload size in bytes"),
  })
  .describe("Webhook configuration for ingress event delivery");

const IngressRateLimitConfigSchema = z
  .object({
    maxRequestsPerMinute: z
      .number({
        error: "ingress.rateLimit.maxRequestsPerMinute must be a number",
      })
      .int("ingress.rateLimit.maxRequestsPerMinute must be an integer")
      .nonnegative(
        "ingress.rateLimit.maxRequestsPerMinute must be a non-negative integer",
      )
      .default(0)
      .describe(
        "Maximum number of ingress requests allowed per minute (0 = unlimited)",
      ),
    maxRequestsPerHour: z
      .number({
        error: "ingress.rateLimit.maxRequestsPerHour must be a number",
      })
      .int("ingress.rateLimit.maxRequestsPerHour must be an integer")
      .nonnegative(
        "ingress.rateLimit.maxRequestsPerHour must be a non-negative integer",
      )
      .default(0)
      .describe(
        "Maximum number of ingress requests allowed per hour (0 = unlimited)",
      ),
  })
  .describe("Rate limiting for ingress requests");

const IngressBaseSchema = z
  .object({
    enabled: z
      .boolean({ error: "ingress.enabled must be a boolean" })
      .optional()
      .describe("Whether the ingress HTTP server is enabled"),
    publicBaseUrl: emptyOrAbsoluteHttpUrl("ingress.publicBaseUrl")
      .default("")
      .describe(
        "Public-facing base URL for the ingress server (used in webhook callbacks)",
      ),
    webhook: IngressWebhookConfigSchema.default(
      IngressWebhookConfigSchema.parse({}),
    ),
    rateLimit: IngressRateLimitConfigSchema.default(
      IngressRateLimitConfigSchema.parse({}),
    ),
    [INGRESS_ASSISTANT_ID_KEY]: z
      .string()
      .optional()
      .describe("The assistant id the tunnel fronted (CLI-owned record)"),
    [INGRESS_LAST_TUNNEL_KEY]: TunnelRecordSchema.optional(),
    [INGRESS_PAIRING_TUNNEL_KEY]: TunnelRecordSchema.optional(),
    publicBaseUrlManagedBy: z
      .string()
      .optional()
      .describe(
        'Who owns the current publicBaseUrl — "tunnel" when the tunnel machinery stamped it, anything else is user-managed (CLI/route-owned bookkeeping)',
      ),
  })
  .describe(
    "Ingress HTTP server configuration — handles incoming webhooks, API requests, and channel events",
  );

export const IngressConfigSchema = IngressBaseSchema.default(
  IngressBaseSchema.parse({}),
);

export type IngressWebhookConfig = z.infer<typeof IngressWebhookConfigSchema>;
export type IngressRateLimitConfig = z.infer<
  typeof IngressRateLimitConfigSchema
>;
export type IngressConfig = z.infer<typeof IngressConfigSchema>;
