/**
 * Tests for the default-provider route handlers.
 *
 * Covers:
 *   GET /v1/config/llm/default-provider — availability per provider kind,
 *     connection/credential states, CES-unreachable vs missing-credential
 *   PUT /v1/config/llm/default-provider — strict validation, persistence
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Module mocks (must come before imports) ──────────────────────────────────

let managedProxyEnabled = false;
let managedProxyBaseUrl = "https://platform.example";
mock.module("../../../providers/cloud-proxy/context.js", () => ({
  resolveCloudProxyContext: async () => ({
    enabled: managedProxyEnabled,
    cloudBaseUrl: managedProxyBaseUrl,
    assistantApiKey: managedProxyEnabled ? "key" : "",
  }),
}));

import { useFaultableSecureKeyMap } from "../../../__tests__/helpers/secure-keys.js";
// The REAL secure-keys module pinned to a faultable memory backend; seeds
// use real credential keys, the unreachable toggle simulates a dead vault.
const { store: secureKeyResults, setAllUnreachable } =
  useFaultableSecureKeyMap();

// ── Real imports (after mocks) ────────────────────────────────────────────────

import { setConfig } from "../../../__tests__/helpers/set-config.js";
import { loadRawConfig } from "../../../config/loader.js";
import { getDb } from "../../../persistence/db-connection.js";
import { initializeDb } from "../../../persistence/db-init.js";
import { providerConnections } from "../../../persistence/schema/inference.js";
import { ROUTES } from "../default-provider-routes.js";
import { BadRequestError } from "../errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "../types.js";

/** Read the `llm.default` blob back from the real workspace config file. */
function persistedDefaultProvider(): unknown {
  const llm = loadRawConfig().llm as Record<string, unknown> | undefined;
  return llm?.default;
}

// ── DB bootstrap ──────────────────────────────────────────────────────────────

await initializeDb();

// ── Helpers ───────────────────────────────────────────────────────────────────

function findRoute(operationId: string): RouteDefinition {
  const route = ROUTES.find((r) => r.operationId === operationId);
  if (!route) {
    throw new Error(`Route ${operationId} not found`);
  }
  return route;
}

async function get(): Promise<Record<string, unknown>> {
  return (await findRoute("llm_default_provider_get").handler({})) as Record<
    string,
    unknown
  >;
}

async function put(body: RouteHandlerArgs["body"]): Promise<unknown> {
  return await findRoute("llm_default_provider_put").handler({ body });
}

function availability(result: Record<string, unknown>): {
  status: string;
  message?: string;
} {
  return result.availability as { status: string; message?: string };
}

function seedConnection(opts: {
  name: string;
  provider: string;
  auth: object;
}): void {
  const now = Date.now();
  getDb()
    .insert(providerConnections)
    .values({
      name: opts.name,
      provider: opts.provider,
      auth: JSON.stringify(opts.auth),
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

function seedCanonicalCadetConnection(): void {
  seedConnection({
    name: "cadet",
    provider: "cadet",
    auth: { type: "platform" },
  });
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  getDb().delete(providerConnections).run();
  setConfig("llm", {});
  managedProxyEnabled = false;
  managedProxyBaseUrl = "https://platform.example";
  secureKeyResults.clear();
  setAllUnreachable(false);
});

// ── GET ───────────────────────────────────────────────────────────────────────

describe("GET config/llm/default-provider", () => {
  test("no default configured → missing_default", async () => {
    const result = await get();
    expect(result.provider).toBeNull();
    expect(result.resolvedConnectionName).toBeNull();
    expect(availability(result).status).toBe("missing_default");
    expect(availability(result).message).toContain("default provider");
  });

  test("cadet + authenticated → ok", async () => {
    seedCanonicalCadetConnection();
    setConfig("llm", { default: { provider: "cadet" } });
    managedProxyEnabled = true;
    const result = await get();
    expect(result.provider).toBe("cadet");
    expect(availability(result)).toEqual({ status: "ok" });
  });

  test("cadet + unauthenticated → cadet_unauthenticated naming the fix", async () => {
    seedCanonicalCadetConnection();
    setConfig("llm", { default: { provider: "cadet" } });
    const result = await get();
    expect(availability(result).status).toBe("cadet_unauthenticated");
    expect(availability(result).message).toContain("Log in");
  });

  test("cadet + no platform URL → cadet_unauthenticated naming the URL", async () => {
    seedCanonicalCadetConnection();
    setConfig("llm", { default: { provider: "cadet" } });
    managedProxyBaseUrl = "";
    const result = await get();
    expect(availability(result).status).toBe("cadet_unauthenticated");
    expect(availability(result).message).toContain("cloud URL");
  });

  test("cadet default with no canonical row → missing_connection", async () => {
    managedProxyEnabled = true;
    setConfig("llm", { default: { provider: "cadet" } });
    const result = await get();
    expect(availability(result).status).toBe("missing_connection");
  });

  test("user-owned connection claiming the cadet name → the cloud's own status", async () => {
    // seedCanonicalConnections skips reseeding when a user row claims the
    // name. Dispatch ignores that row and routes through cloud auth, so a
    // signed-in platform is genuinely usable and reads as ok.
    seedConnection({
      name: "cadet",
      provider: "anthropic",
      auth: { type: "api_key", credential: "credential/anthropic/api_key" },
    });
    secureKeyResults.set("credential/anthropic/api_key", "sk-ant");
    managedProxyEnabled = true;
    setConfig("llm", { default: { provider: "cadet" } });

    const result = await get();
    expect(availability(result).status).toBe("ok");
  });

  test("cloud-auth connection for a non-cloud provider → unsupported_auth even when signed in", async () => {
    seedConnection({
      name: "openrouter-personal",
      provider: "openrouter",
      auth: { type: "platform" },
    });
    managedProxyEnabled = true;
    setConfig("llm", { default: { provider: "openrouter" } });

    const result = await get();
    expect(availability(result).status).toBe("unsupported_auth");
    expect(availability(result).message).toContain("Cadet Cloud auth");
  });

  test("BYOK with stored key → ok, convention-resolved connection", async () => {
    seedConnection({
      name: "anthropic-personal",
      provider: "anthropic",
      auth: { type: "api_key", credential: "credential/anthropic/api_key" },
    });
    secureKeyResults.set("credential/anthropic/api_key", "sk-ant");
    setConfig("llm", { default: { provider: "anthropic" } });

    const result = await get();
    expect(result.resolvedConnectionName).toBe("anthropic-personal");
    expect(result.connectionName).toBeUndefined();
    expect(availability(result)).toEqual({ status: "ok" });
  });

  test("explicit connectionName wins over convention", async () => {
    seedConnection({
      name: "work-openai",
      provider: "openai",
      auth: { type: "api_key", credential: "credential/openai/api_key" },
    });
    secureKeyResults.set("credential/openai/api_key", "sk-oai");
    setConfig("llm", {
      default: { provider: "openai", provider_connection: "work-openai" },
    });

    const result = await get();
    expect(result.connectionName).toBe("work-openai");
    expect(result.resolvedConnectionName).toBe("work-openai");
    expect(availability(result)).toEqual({ status: "ok" });
  });

  test("no connection row → missing_connection naming connection and provider", async () => {
    setConfig("llm", { default: { provider: "openai" } });
    const result = await get();
    expect(availability(result).status).toBe("missing_connection");
    expect(availability(result).message).toContain('"openai-personal"');
    expect(availability(result).message).toContain('"openai"');
  });

  test("api_key connection with no stored key → missing_credential", async () => {
    seedConnection({
      name: "anthropic-personal",
      provider: "anthropic",
      auth: { type: "api_key", credential: "credential/anthropic/api_key" },
    });
    setConfig("llm", { default: { provider: "anthropic" } });

    const result = await get();
    expect(availability(result).status).toBe("missing_credential");
    expect(availability(result).message).toContain("API key");
    expect(availability(result).message).toContain('"anthropic-personal"');
  });

  test("credential store unreachable → unknown, never missing_credential", async () => {
    seedConnection({
      name: "anthropic-personal",
      provider: "anthropic",
      auth: { type: "api_key", credential: "credential/anthropic/api_key" },
    });
    setAllUnreachable(true);
    setConfig("llm", { default: { provider: "anthropic" } });

    const result = await get();
    expect(availability(result).status).toBe("unknown");
    expect(availability(result).message).toContain("unreachable");
  });

  test("cadet + credential store unreachable → unknown, not logged-out", async () => {
    seedCanonicalCadetConnection();
    setConfig("llm", { default: { provider: "cadet" } });
    setAllUnreachable(true);
    const result = await get();
    expect(availability(result).status).toBe("unknown");
    expect(availability(result).message).toContain("unreachable");
  });

  test("cadet with a dangling explicit connectionName → missing_connection", async () => {
    setConfig("llm", {
      default: { provider: "cadet", connectionName: "ghost" },
    });
    const result = await get();
    expect(availability(result).status).toBe("missing_connection");
  });

  test("cadet pinned to another provider's connection → provider_mismatch", async () => {
    seedConnection({
      name: "anthropic-personal",
      provider: "anthropic",
      auth: { type: "api_key", credential: "credential/anthropic/api_key" },
    });
    secureKeyResults.set("credential/anthropic/api_key", "sk-ant");
    setConfig("llm", {
      default: {
        provider: "cadet",
        provider_connection: "anthropic-personal",
      },
    });
    const result = await get();
    expect(availability(result).status).toBe("provider_mismatch");
  });

  test("none-auth connection on a keyed provider → unsupported_auth", async () => {
    seedConnection({
      name: "openai-personal",
      provider: "openai",
      auth: { type: "none" },
    });
    setConfig("llm", { default: { provider: "openai" } });

    const result = await get();
    expect(availability(result).status).toBe("unsupported_auth");
    expect(availability(result).message).toContain("API key");
  });

  test("explicit connectionName for a different provider → provider_mismatch even with credentials", async () => {
    seedConnection({
      name: "anthropic-personal",
      provider: "anthropic",
      auth: { type: "api_key", credential: "credential/anthropic/api_key" },
    });
    secureKeyResults.set("credential/anthropic/api_key", "sk-ant");
    setConfig("llm", {
      default: {
        provider: "openai",
        provider_connection: "anthropic-personal",
      },
    });

    const result = await get();
    expect(availability(result).status).toBe("provider_mismatch");
    expect(availability(result).message).toContain('"anthropic"');
    expect(availability(result).message).toContain('"openai"');
  });

  test("cadet-cloud connection pinned for a cloud-routable provider follows cloud auth", async () => {
    seedConnection({
      name: "cadet",
      provider: "cadet",
      auth: { type: "platform" },
    });
    setConfig("llm", {
      default: { provider: "anthropic", provider_connection: "cadet" },
    });

    expect(availability(await get()).status).toBe("cadet_unauthenticated");
    managedProxyEnabled = true;
    expect(availability(await get()).status).toBe("ok");
  });

  test("cadet-cloud connection pinned for a non-cloud provider → provider_mismatch", async () => {
    seedConnection({
      name: "cadet",
      provider: "cadet",
      auth: { type: "platform" },
    });
    managedProxyEnabled = true;
    setConfig("llm", {
      default: { provider: "openrouter", provider_connection: "cadet" },
    });

    const result = await get();
    expect(availability(result).status).toBe("provider_mismatch");
    expect(availability(result).message).toContain("Cadet Cloud");
  });

  test("service_account connection with invalid credential → missing_credential", async () => {
    seedConnection({
      name: "gemini-personal",
      provider: "gemini",
      auth: { type: "service_account", credential: "credential/gemini/sa" },
    });
    secureKeyResults.set("credential/gemini/sa", "{}");
    setConfig("llm", { default: { provider: "gemini" } });

    const result = await get();
    expect(availability(result).status).toBe("missing_credential");
    expect(availability(result).message).toContain("service-account");
  });

  test("cloud-auth connection follows cloud-proxy state", async () => {
    seedConnection({
      name: "anthropic-personal",
      provider: "anthropic",
      auth: { type: "platform" },
    });
    setConfig("llm", { default: { provider: "anthropic" } });

    expect(availability(await get()).status).toBe("cadet_unauthenticated");
    managedProxyEnabled = true;
    expect(availability(await get()).status).toBe("ok");
  });
});

// ── PUT ───────────────────────────────────────────────────────────────────────

describe("PUT config/llm/default-provider", () => {
  test("valid body persists and returns fresh status", async () => {
    seedConnection({
      name: "openai-personal",
      provider: "openai",
      auth: { type: "api_key", credential: "credential/openai/api_key" },
    });
    secureKeyResults.set("credential/openai/api_key", "sk-oai");

    const result = (await put({ provider: "openai" })) as Record<
      string,
      unknown
    >;

    expect(persistedDefaultProvider()).toEqual({ provider: "openai" });
    expect(result.provider).toBe("openai");
    expect(availability(result)).toEqual({ status: "ok" });
  });

  test("chatgpt persists and resolves the canonical subscription row", async () => {
    seedConnection({
      name: "chatgpt-subscription",
      provider: "chatgpt",
      auth: {
        type: "oauth_subscription",
        credential: "credential/chatgpt/access_token",
      },
    });
    secureKeyResults.set("credential/chatgpt/access_token", "token");

    const result = (await put({ provider: "chatgpt" })) as Record<
      string,
      unknown
    >;

    expect(persistedDefaultProvider()).toEqual({ provider: "chatgpt" });
    expect(result.provider).toBe("chatgpt");
    expect(result.resolvedConnectionName).toBe("chatgpt-subscription");
    expect(availability(result)).toEqual({ status: "ok" });
  });

  test("persists an explicit connectionName as the blob's pin", async () => {
    await put({ provider: "openai", connectionName: "work-openai" });
    expect(persistedDefaultProvider()).toEqual({
      provider: "openai",
      provider_connection: "work-openai",
    });
  });

  test("dangling connection is accepted and reported via availability", async () => {
    const result = (await put({ provider: "gemini" })) as Record<
      string,
      unknown
    >;
    expect(persistedDefaultProvider()).toEqual({ provider: "gemini" });
    expect(availability(result).status).toBe("missing_connection");
  });

  test("a noncanonical pin on a routing identity → 400 naming the canonical row", async () => {
    for (const [provider, canonical] of [
      ["chatgpt", "chatgpt-subscription"],
      ["cadet", "cadet"],
    ] as const) {
      const err = await put({
        provider,
        connectionName: "some-other-row",
      }).catch((e: unknown) => e);
      expect(String(err)).toContain(canonical);
    }
  });

  test("the canonical pin on a routing identity is accepted", async () => {
    seedConnection({
      name: "chatgpt-subscription",
      provider: "chatgpt",
      auth: {
        type: "oauth_subscription",
        credential: "credential/chatgpt/access_token",
      },
    });
    secureKeyResults.set("credential/chatgpt/access_token", "token");

    const result = (await put({
      provider: "chatgpt",
      connectionName: "chatgpt-subscription",
    })) as Record<string, unknown>;

    expect(result.resolvedConnectionName).toBe("chatgpt-subscription");
    expect(availability(result)).toEqual({ status: "ok" });
  });

  test("invalid provider → 400 naming the allowed providers", async () => {
    const err = await put({ provider: "not-a-provider" }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BadRequestError);
    expect((err as BadRequestError).message).toContain("anthropic");
    expect((err as BadRequestError).message).toContain("cadet");
    expect(persistedDefaultProvider()).toBeUndefined();
  });

  test("unknown keys are stripped from the persisted value", async () => {
    await put({ provider: "anthropic", extra: "nope" });
    expect(persistedDefaultProvider()).toEqual({ provider: "anthropic" });
  });
});

// ── Route policy ──────────────────────────────────────────────────────────────

describe("route policy", () => {
  test("GET requires settings.read; PUT requires settings.write", () => {
    expect(
      findRoute("llm_default_provider_get").policy?.requiredScopes,
    ).toEqual(["settings.read"]);
    expect(
      findRoute("llm_default_provider_put").policy?.requiredScopes,
    ).toEqual(["settings.write"]);
  });
});
