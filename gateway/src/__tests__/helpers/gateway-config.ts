import type { GatewayConfig } from "../../config.js";

/**
 * Canonical GatewayConfig test fixture (PR 648 review: seven test files
 * carried byte-identical copies of this object — centralize). Pass
 * `overrides` for the per-file deltas; everything else stays in lockstep so
 * a new required config field lands here once, not seven times.
 */
export function makeGatewayConfig(
  overrides: Partial<GatewayConfig> = {},
): GatewayConfig {
  return {
    assistantRuntimeBaseUrl: "http://localhost:7821",
    gatewayInternalBaseUrl: "http://127.0.0.1:7830",
    logFile: { dir: undefined, retentionDays: 30 },
    maxAttachmentBytes: {
      telegram: 50 * 1024 * 1024,
      slack: 100 * 1024 * 1024,
      whatsapp: 16 * 1024 * 1024,
      default: 50 * 1024 * 1024,
    },
    maxAttachmentConcurrency: 3,
    maxWebhookPayloadBytes: 1024 * 1024,
    port: 7830,
    routingEntries: [],
    runtimeInitialBackoffMs: 500,
    runtimeMaxRetries: 2,
    runtimeProxyRequireAuth: false,
    runtimeTimeoutMs: 30000,
    trustProxy: false,
    ...overrides,
  } as unknown as GatewayConfig;
}
