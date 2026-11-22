import { contactRoutes } from "./contact-handlers.js";
import { inviteRoutes } from "./invite-handlers.js";
import { verificationSessionRoutes } from "./verification-session-handlers.js";
import { guardianRequestRoutes } from "./guardian-request-handlers.js";
import { admissionPolicyRoutes } from "./admission-policy-handlers.js";
import { channelPermissionRoutes } from "./channel-permission-handlers.js";
import { trustVerdictRoutes } from "./trust-verdict-handlers.js";
import { guardianDeliveryRoutes } from "./guardian-delivery-handlers.js";
import { logTailRoutes } from "./log-tail-handlers.js";
import { channelSocketHealthRoutes } from "./channel-socket-health-handlers.js";
import { credentialRequestRoutes } from "./credential-request-handlers.js";
import { slackThreadRoutes } from "./slack-thread-handlers.js";
import { thresholdRoutes } from "./threshold-handlers.js";
import { trustRulesRoutes } from "./trust-rules-handlers.js";
import { riskClassificationRoutes } from "./risk-classification-handlers.js";
import { tunnelRoutes } from "./tunnel-handlers.js";
import { webhookRouteRoutes } from "./webhook-route-handlers.js";

export const ROUTES = [
  ...contactRoutes,
  ...inviteRoutes,
  ...verificationSessionRoutes,
  ...guardianRequestRoutes,
  ...slackThreadRoutes,
  ...thresholdRoutes,
  ...admissionPolicyRoutes,
  ...channelPermissionRoutes,
  ...trustVerdictRoutes,
  ...guardianDeliveryRoutes,
  ...riskClassificationRoutes,
  ...logTailRoutes,
  ...channelSocketHealthRoutes,
  ...trustRulesRoutes,
  ...tunnelRoutes,
  ...webhookRouteRoutes,
  ...credentialRequestRoutes,
];
