/**
 * Unit tests for `hasWebhookRoutingConfigured`'s resolution order (LUM-2882).
 *
 * The predicate has to agree with `handleWebhooksRegister` in
 * `runtime/routes/webhook-routes.ts` tier for tier. Where they disagree, the
 * status surfaces (channel readiness, the Telegram webhook health sweep) report
 * a state the registration path contradicts, which hides a broken registration
 * instead of surfacing it. The tier cases here mirror the ones in
 * `runtime/routes/__tests__/webhook-routes.test.ts`.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

let isPlatform = false;
let tunnelWebhooksEnabled = false;
let rawConfig: Record<string, unknown> = {};
let cloudContextEnabled = false;

// Spread the real modules: these are broad barrels and replacing them wholesale
// breaks unrelated importers pulled in by the module under test.
const actualEnvRegistry = await import("../env-registry.js");
mock.module("../env-registry.js", () => ({
  ...actualEnvRegistry,
  getIsCloud: () => isPlatform,
}));

const actualLoader = await import("../loader.js");
mock.module("../loader.js", () => ({
  ...actualLoader,
  loadRawConfig: () => rawConfig,
  getConfig: () => rawConfig,
}));

const actualTunnelGate = await import("../../inbound/tunnel-webhooks-gate.js");
mock.module("../../inbound/tunnel-webhooks-gate.js", () => ({
  ...actualTunnelGate,
  isTunnelWebhooksEnabled: () => tunnelWebhooksEnabled,
}));

const actualRegistration =
  await import("../../inbound/cloud-callback-registration.js");
mock.module("../../inbound/cloud-callback-registration.js", () => ({
  ...actualRegistration,
  resolveCloudCallbackRegistrationContext: async () => ({
    isPlatform,
    cloudBaseUrl: "https://cloud.mycadet.ai",
    assistantId: cloudContextEnabled ? "assistant-123" : "",
    hasAssistantApiKey: cloudContextEnabled,
    authHeader: cloudContextEnabled ? "Api-Key secret" : null,
    enabled: cloudContextEnabled,
  }),
}));

const { hasIngressConfigured, hasWebhookRoutingConfigured } =
  await import("../webhook-routing.js");

describe("hasWebhookRoutingConfigured resolution order", () => {
  beforeEach(() => {
    isPlatform = false;
    tunnelWebhooksEnabled = false;
    rawConfig = {};
    cloudContextEnabled = false;
  });

  // ── Tier 1: cloud pods ────────────────────────────────────────────────

  test("cloud pods use managed callbacks", async () => {
    isPlatform = true;

    expect(await hasWebhookRoutingConfigured(true)).toEqual({
      configured: true,
      usesCloudCallbacks: true,
    });
  });

  test("cloud pods report managed even with an ingress URL configured", async () => {
    isPlatform = true;
    rawConfig = { ingress: { publicBaseUrl: "https://tunnel.example.com" } };

    // `handleWebhooksRegister` registers with the cloud gateway before it
    // ever reads the ingress config on a pod, so reporting the ingress URL
    // here would name a URL no webhook is actually registered against.
    expect(await hasWebhookRoutingConfigured(true)).toEqual({
      configured: true,
      usesCloudCallbacks: true,
    });
  });

  test("tunnel-webhooks on: a pod with a published ingress URL reports it", async () => {
    isPlatform = true;
    tunnelWebhooksEnabled = true;
    rawConfig = { ingress: { publicBaseUrl: "https://tunnel.example.com" } };

    expect(await hasWebhookRoutingConfigured(true)).toEqual({
      configured: true,
      usesCloudCallbacks: false,
    });
  });

  test("tunnel-webhooks on: a pod with no published URL still reports managed", async () => {
    isPlatform = true;
    tunnelWebhooksEnabled = true;

    expect(await hasWebhookRoutingConfigured(true)).toEqual({
      configured: true,
      usesCloudCallbacks: true,
    });
  });

  test("tunnel-webhooks on: a pod with ingress disabled falls back to managed", async () => {
    isPlatform = true;
    tunnelWebhooksEnabled = true;
    rawConfig = { ingress: { enabled: false } };

    // Matches `resolveCallbackUrl` on pods: an owner toggling ingress off
    // must not lose webhooks entirely.
    expect(await hasWebhookRoutingConfigured(true)).toEqual({
      configured: true,
      usesCloudCallbacks: true,
    });
  });

  // ── Tier 2: a configured ingress wins ────────────────────────────────────

  test("ingress beats the cloud-connected fallback", async () => {
    cloudContextEnabled = true;
    rawConfig = { ingress: { publicBaseUrl: "https://tunnel.example.com" } };

    // Any logged-in local assistant holds platform credentials for the LLM
    // proxy, so credential presence must not reroute an explicitly configured
    // self-hosted webhook through the cloud.
    expect(await hasWebhookRoutingConfigured(true)).toEqual({
      configured: true,
      usesCloudCallbacks: false,
    });
  });

  test("the twilio option resolves ingress before the fallback too", async () => {
    cloudContextEnabled = true;
    rawConfig = { ingress: { publicBaseUrl: "https://twilio.example.com" } };

    expect(await hasWebhookRoutingConfigured(true, { twilio: true })).toEqual({
      configured: true,
      usesCloudCallbacks: false,
    });
  });

  test("the twilio option falls back to managed callbacks with no ingress", async () => {
    cloudContextEnabled = true;

    expect(await hasWebhookRoutingConfigured(true, { twilio: true })).toEqual({
      configured: true,
      usesCloudCallbacks: true,
    });
  });

  // ── Tier 3: platform-connected fallback ──────────────────────────────────

  test("a cloud-connected assistant with no ingress uses managed callbacks", async () => {
    cloudContextEnabled = true;

    // The LUM-2882 case: `webhooks register` hands back a cloud callback
    // URL here, so the status surfaces must not report missing ingress.
    expect(await hasWebhookRoutingConfigured(true)).toEqual({
      configured: true,
      usesCloudCallbacks: true,
    });
  });

  test("the fallback applies when the ingress URL is present but empty", async () => {
    cloudContextEnabled = true;
    rawConfig = { ingress: { publicBaseUrl: "" } };

    expect(await hasWebhookRoutingConfigured(true)).toEqual({
      configured: true,
      usesCloudCallbacks: true,
    });
  });

  test("an explicit ingress.enabled false blocks the fallback", async () => {
    cloudContextEnabled = true;
    rawConfig = { ingress: { enabled: false } };

    // Opting out is a decision not to accept inbound webhooks at all, not an
    // invitation to route them through the cloud instead.
    expect(await hasWebhookRoutingConfigured(true)).toEqual({
      configured: false,
      usesCloudCallbacks: false,
    });
  });

  test("ingress.enabled false blocks the fallback even with a URL configured", async () => {
    cloudContextEnabled = true;
    rawConfig = {
      ingress: { enabled: false, publicBaseUrl: "https://tunnel.example.com" },
    };

    expect(await hasWebhookRoutingConfigured(true)).toEqual({
      configured: false,
      usesCloudCallbacks: false,
    });
  });

  // ── Tier 4: nothing configured ───────────────────────────────────────────

  test("no ingress and no platform connectivity is not configured", async () => {
    expect(await hasWebhookRoutingConfigured(true)).toEqual({
      configured: false,
      usesCloudCallbacks: false,
    });
  });

  // ── allowCloudCallbacks gating ─────────────────────────────────────────

  test("allowCloudCallbacks false hides the cloud-connected fallback", async () => {
    cloudContextEnabled = true;

    // Channels that can only be served by a self-hosted ingress pass `false`
    // and must never be told a cloud route stands in for one.
    expect(await hasWebhookRoutingConfigured(false)).toEqual({
      configured: false,
      usesCloudCallbacks: false,
    });
  });

  test("allowCloudCallbacks false hides the cloud-pod tier", async () => {
    isPlatform = true;

    expect(await hasWebhookRoutingConfigured(false)).toEqual({
      configured: false,
      usesCloudCallbacks: false,
    });
  });

  test("allowCloudCallbacks false still honors a configured ingress", async () => {
    rawConfig = { ingress: { publicBaseUrl: "https://tunnel.example.com" } };

    expect(await hasWebhookRoutingConfigured(false)).toEqual({
      configured: true,
      usesCloudCallbacks: false,
    });
  });
});

describe("hasIngressConfigured", () => {
  beforeEach(() => {
    isPlatform = false;
    rawConfig = {};
    cloudContextEnabled = false;
  });

  test("is unaffected by platform connectivity", () => {
    cloudContextEnabled = true;

    expect(hasIngressConfigured()).toBe(false);
  });

  test("treats an unset enabled flag with a URL as enabled", () => {
    rawConfig = { ingress: { publicBaseUrl: "https://tunnel.example.com" } };

    expect(hasIngressConfigured()).toBe(true);
  });

  test("treats an explicit enabled false as not configured", () => {
    rawConfig = {
      ingress: { enabled: false, publicBaseUrl: "https://tunnel.example.com" },
    };

    expect(hasIngressConfigured()).toBe(false);
  });
});
