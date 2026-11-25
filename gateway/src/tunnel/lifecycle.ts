import { onWebhookIngressRoutesChanged } from "../db/webhook-ingress-route-store.js";
import { getTunnelClient } from "./client.js";

/**
 * Start the process-wide tunnel client and return its stop thunk. The tunnel
 * is the browser's ingress for web live voice, so it starts unconditionally;
 * from here the client self-manages (ingress disable/enable transitions,
 * reconnects) until the stop thunk runs at gateway shutdown.
 */
export function startTunnelClient(): () => void {
  const tunnelClient = getTunnelClient();
  tunnelClient.start();
  // Tunnel only sees a webhook route on the next tunnel connect, so a registry
  // write changes the advertised rules, so the tunnel re-advertises them on
  // its next connect.
  const unsubscribeWebhookRoutesChanged = onWebhookIngressRoutesChanged(() => {
    tunnelClient.requestRulesRefresh("webhook-routes-changed");
  });
  return () => {
    unsubscribeWebhookRoutesChanged();
    tunnelClient.stop();
  };
}
