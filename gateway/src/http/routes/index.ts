/**
 * The gateway's route barrel.
 *
 * This module owns the single ordered route table: every HTTP route the
 * gateway serves is declared in a per-domain `ROUTES` array and concatenated
 * here, in dispatch order (first match wins — the runtime-proxy catch-all
 * must stay last). Both consumers import THIS module:
 *
 * - the gateway server (`index.ts`) spreads `ROUTES` into `createRouter`
 *   after wiring deps with `initGatewayRoutes`, and
 * - the OpenAPI generation script (`scripts/generate-openapi.ts`) reads the
 *   same `ROUTES` to project the published spec, so the tested routes cannot
 *   drift from production.
 *
 * Route modules stay import-safe (no side effects): anything a handler needs
 * from server startup is injected through `initGatewayRoutes` and read
 * lazily — so the generation script can import the table without wiring a
 * live gateway.
 */

import type { AuthRateLimiter } from "../../auth-rate-limiter.js";
import type { ConfigFileCache } from "../../config-file-cache.js";
import type { GatewayConfig } from "../../config.js";
import type { CredentialCache } from "../../credential-cache.js";
import type { TunnelClient } from "../../tunnel/client.js";
import type { GatewayRouteDefinition } from "./types.js";
import {
  ROUTES as webhookRoutes,
  initWebhookRoutes,
  type WebhookDedupCaches,
} from "./webhook-routes.js";
import { ROUTES as audioRoutes, initAudioRoutes } from "./audio-proxy.js";
import {
  ROUTES as runtimeHealthRoutes,
  initRuntimeHealthRoutes,
} from "./runtime-health-proxy.js";
import { ROUTES as psRoutes, initPsRoutes } from "./ps.js";
import {
  ROUTES as ingressDomainRoutes,
  initIngressDomainRoutes,
} from "./ingress-domains.js";
import {
  ROUTES as tunnelStatusRoutes,
  initTunnelStatusRoutes,
} from "./tunnel-status.js";
import {
  ROUTES as brainGraphRoutes,
  initBrainGraphRoutes,
} from "./brain-graph-proxy.js";
import {
  ROUTES as telegramControlPlaneRoutes,
  initTelegramControlPlaneRoutes,
} from "./telegram-control-plane-proxy.js";
import {
  ROUTES as vercelControlPlaneRoutes,
  initVercelControlPlaneRoutes,
} from "./vercel-control-plane-proxy.js";
import {
  ROUTES as contactsRoutes,
  initContactsControlPlaneRoutes,
} from "./contacts-control-plane-route-table.js";
import { createContactsControlPlaneProxyHandler } from "./contacts-control-plane-proxy.js";
import {
  handleContactPromptSubmit,
  handleContactRecordSubmit,
} from "./contact-prompt.js";
import { ROUTES as pairingRoutes } from "./remote-web-pairing-routes.js";
import { ROUTES as credentialEntryRoutes } from "./credential-entry-page.js";
import { ROUTES as credentialRequestRoutes } from "./credential-requests.js";
import { ROUTES as devicesMineRoutes } from "./devices-mine.js";
import {
  ROUTES as channelVerificationRoutes,
  initChannelVerificationSessionRoutes,
} from "./channel-verification-session-proxy.js";
import {
  ROUTES as guardianRefreshRoutes,
  initGuardianRefreshRoutes,
} from "./guardian-refresh.js";
import {
  ROUTES as twilioControlPlaneRoutes,
  initTwilioControlPlaneRoutes,
} from "./twilio-control-plane-proxy.js";
import {
  ROUTES as slackControlPlaneRoutes,
  initSlackControlPlaneRoutes,
} from "./slack-control-plane-proxy.js";
import {
  ROUTES as oauthProviderRoutes,
  initOAuthProvidersRoutes,
} from "./oauth-providers-proxy.js";
import {
  ROUTES as oauthAppRoutes,
  initOAuthAppsRoutes,
} from "./oauth-apps-proxy.js";
import {
  ROUTES as upgradeBroadcastRoutes,
  initUpgradeBroadcastRoutes,
} from "./upgrade-broadcast-proxy.js";
import {
  ROUTES as workspaceCommitRoutes,
  initWorkspaceCommitRoutes,
} from "./workspace-commit-proxy.js";
import {
  ROUTES as migrationRollbackRoutes,
  initMigrationRollbackRoutes,
} from "./migration-rollback-proxy.js";
import {
  ROUTES as cloudPushRoutes,
  initCloudPushRoutes,
} from "./cloud-push-proxy.js";
import {
  ROUTES as channelReadinessRoutes,
  initChannelReadinessRoutes,
} from "./channel-readiness-proxy.js";
import {
  ROUTES as integrationsStatusRoutes,
  initIntegrationsStatusRoutes,
} from "./integrations-status.js";
import { ROUTES as autoApproveThresholdRoutes } from "./auto-approve-thresholds.js";
import {
  ROUTES as logExportRoutes,
  initLogExportRoutes,
} from "./log-export.js";
import { ROUTES as logTailRoutes, initLogTailRoutes } from "./log-tail.js";
import { ROUTES as upgradePolicyRoutes } from "./upgrade-policy.js";
import { ROUTES as trustRuleRoutes } from "./trust-rules.js";
import { ROUTES as channelAdmissionPolicyRoutes } from "./channel-admission-policy.js";
import { ROUTES as channelIngressRoutes } from "./channel-ingress.js";
import { ROUTES as channelPermissionOverrideRoutes } from "./channel-permission-overrides.js";
import {
  ROUTES as desktopSetupRoutes,
  initDesktopSetupRoutes,
} from "./desktop-setup-proxy.js";
import {
  ROUTES as runtimeProxyRoutes,
  initRuntimeProxyRoutes,
} from "./runtime-proxy.js";

export interface GatewayRoutesDeps {
  config: GatewayConfig;
  credentials: CredentialCache;
  configFile: ConfigFileCache;
  tunnelClient: TunnelClient | undefined;
  authRateLimiter: AuthRateLimiter;
  isTelegramConfigured: () => boolean;
  isWhatsAppConfigured: () => boolean;
}

/**
 * Wire the startup state every route module's handlers close over. Called
 * once by the gateway server before the router is built; the OpenAPI
 * generation script never calls it (handlers never run there). Returns the
 * webhook dedup caches, whose lifecycle the server process owns.
 */
export function initGatewayRoutes(deps: GatewayRoutesDeps): WebhookDedupCaches {
  const dedupCaches = initWebhookRoutes({
    config: deps.config,
    credentials: deps.credentials,
    configFile: deps.configFile,
    isTelegramConfigured: deps.isTelegramConfigured,
    isWhatsAppConfigured: deps.isWhatsAppConfigured,
  });
  initAudioRoutes(deps.config);
  initRuntimeHealthRoutes(deps.config);
  initPsRoutes(deps.config);
  initIngressDomainRoutes(deps.configFile);
  initTunnelStatusRoutes(deps.tunnelClient);
  initBrainGraphRoutes(deps.config);
  initTelegramControlPlaneRoutes(deps.config);
  initVercelControlPlaneRoutes(deps.config);
  initContactsControlPlaneRoutes({
    contactsControlPlaneProxy: createContactsControlPlaneProxyHandler(
      deps.config,
    ),
    handleContactPromptSubmit,
    handleContactRecordSubmit,
  });
  initChannelVerificationSessionRoutes(deps.config);
  initGuardianRefreshRoutes(deps.authRateLimiter);
  initTwilioControlPlaneRoutes(deps.config);
  initSlackControlPlaneRoutes(deps.config);
  initOAuthProvidersRoutes(deps.config);
  initOAuthAppsRoutes(deps.config);
  initUpgradeBroadcastRoutes(deps.config);
  initWorkspaceCommitRoutes(deps.config);
  initMigrationRollbackRoutes(deps.config);
  initCloudPushRoutes(deps.credentials);
  initChannelReadinessRoutes(deps.config);
  initIntegrationsStatusRoutes(deps.configFile);
  initLogExportRoutes(deps.config);
  initLogTailRoutes(deps.config);
  initDesktopSetupRoutes(deps.config);
  initRuntimeProxyRoutes(deps.config);
  return dedupCaches;
}

/**
 * The gateway's full route table, in dispatch order. The runtime-proxy
 * catch-all is last on purpose — every specific route must win first.
 */
export const ROUTES: readonly GatewayRouteDefinition[] = [
  ...webhookRoutes,
  ...audioRoutes,
  ...runtimeHealthRoutes,
  ...psRoutes,
  ...ingressDomainRoutes,
  ...tunnelStatusRoutes,
  ...brainGraphRoutes,
  ...telegramControlPlaneRoutes,
  ...vercelControlPlaneRoutes,
  ...contactsRoutes,
  ...pairingRoutes,
  ...credentialEntryRoutes,
  ...credentialRequestRoutes,
  ...devicesMineRoutes,
  ...channelVerificationRoutes,
  ...guardianRefreshRoutes,
  ...twilioControlPlaneRoutes,
  ...slackControlPlaneRoutes,
  ...oauthProviderRoutes,
  ...oauthAppRoutes,
  ...upgradeBroadcastRoutes,
  ...workspaceCommitRoutes,
  ...migrationRollbackRoutes,
  ...cloudPushRoutes,
  ...channelReadinessRoutes,
  ...integrationsStatusRoutes,
  ...autoApproveThresholdRoutes,
  ...logExportRoutes,
  ...logTailRoutes,
  ...upgradePolicyRoutes,
  ...trustRuleRoutes,
  ...channelAdmissionPolicyRoutes,
  ...channelIngressRoutes,
  ...channelPermissionOverrideRoutes,
  ...desktopSetupRoutes,
  ...runtimeProxyRoutes,
];
