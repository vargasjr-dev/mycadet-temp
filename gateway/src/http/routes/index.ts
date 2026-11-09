import type { RouteDefinition } from "./types.js";
import { ROUTES as webhookRoutes } from "./webhook-routes.js";
import { ROUTES as audioRoutes } from "./audio-proxy.js";
import { ROUTES as runtimeHealthRoutes } from "./runtime-health-proxy.js";
import { ROUTES as psRoutes } from "./ps.js";
import { ROUTES as ingressDomainRoutes } from "./ingress-domains.js";
import { ROUTES as tunnelStatusRoutes } from "./tunnel-status.js";
import { ROUTES as brainGraphRoutes } from "./brain-graph-proxy.js";
import { ROUTES as telegramControlPlaneRoutes } from "./telegram-control-plane-proxy.js";
import { ROUTES as vercelControlPlaneRoutes } from "./vercel-control-plane-proxy.js";
import { ROUTES as contactsRoutes } from "./contacts-control-plane-route-table.js";
import { ROUTES as pairingRoutes } from "./remote-web-pairing-routes.js";
import { ROUTES as credentialEntryRoutes } from "./credential-entry-page.js";
import { ROUTES as credentialRequestRoutes } from "./credential-requests.js";
import { ROUTES as devicesMineRoutes } from "./devices-mine.js";
import { ROUTES as channelVerificationRoutes } from "./channel-verification-session-proxy.js";
import { ROUTES as guardianRefreshRoutes } from "./guardian-refresh.js";
import { ROUTES as twilioControlPlaneRoutes } from "./twilio-control-plane-proxy.js";
import { ROUTES as slackControlPlaneRoutes } from "./slack-control-plane-proxy.js";
import { ROUTES as oauthProviderRoutes } from "./oauth-providers-proxy.js";
import { ROUTES as oauthAppRoutes } from "./oauth-apps-proxy.js";
import { ROUTES as upgradeBroadcastRoutes } from "./upgrade-broadcast-proxy.js";
import { ROUTES as workspaceCommitRoutes } from "./workspace-commit-proxy.js";
import { ROUTES as migrationRollbackRoutes } from "./migration-rollback-proxy.js";
import { ROUTES as cloudPushRoutes } from "./cloud-push-proxy.js";
import { ROUTES as channelReadinessRoutes } from "./channel-readiness-proxy.js";
import { ROUTES as integrationsStatusRoutes } from "./integrations-status.js";
import { ROUTES as autoApproveThresholdRoutes } from "./auto-approve-thresholds.js";
import { ROUTES as logExportRoutes } from "./log-export.js";
import { ROUTES as logTailRoutes } from "./log-tail.js";
import { ROUTES as upgradePolicyRoutes } from "./upgrade-policy.js";
import { ROUTES as trustRuleRoutes } from "./trust-rules.js";
import { ROUTES as channelAdmissionPolicyRoutes } from "./channel-admission-policy.js";
import { ROUTES as channelIngressRoutes } from "./channel-ingress.js";
import { ROUTES as channelPermissionOverrideRoutes } from "./channel-permission-overrides.js";
import { ROUTES as desktopSetupRoutes } from "./desktop-setup-proxy.js";
import { ROUTES as runtimeProxyRoutes } from "./runtime-proxy.js";

export {
  webhookDedupCaches,
  type WebhookDedupCaches,
} from "./webhook-routes.js";

/** The full route table, in dispatch order — the runtime-proxy catch-all last. */
export const ROUTES: readonly RouteDefinition[] = [
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
