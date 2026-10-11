import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";

const TUNNEL_WEBHOOKS_FLAG_KEY = "tunnel-webhooks" as const;

/**
 * Whether cloud pods resolve webhook callback URLs from the
 * Tunnel-published ingress URL instead of registering platform callback
 * routes.
 *
 * Gates the cloud-pod tier in all three webhook resolution sites
 * (`resolveCallbackUrl`, `hasWebhookRoutingConfigured`,
 * `handleWebhooksRegister`), which must agree tier for tier. Off means the
 * pre-Tunnel behavior: cloud pods always register with the cloud
 * gateway. On means ingress-first with platform registration as the
 * fallback, so a pod whose tunnel has not published a URL yet keeps
 * working either way.
 */
export function isTunnelWebhooksEnabled(): boolean {
  return isAssistantFeatureFlagEnabled(TUNNEL_WEBHOOKS_FLAG_KEY);
}
