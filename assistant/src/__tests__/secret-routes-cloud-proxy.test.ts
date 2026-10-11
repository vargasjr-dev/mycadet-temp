import { beforeEach, describe, expect, mock, test } from "bun:test";

import { eq } from "drizzle-orm";

import { getConfig } from "../config/loader.js";
import { getDb } from "../persistence/db-connection.js";
import { providerConnections } from "../persistence/schema/inference.js";
import { credentialKey } from "../security/credential-key.js";
import { useFaultableSecureKeyMap } from "./helpers/secure-keys.js";

// The REAL secure-keys module pinned to a faultable memory backend — the
// tests index the store directly and toggle write failures, same as the old
// inline fake did.
const { store: secureKeyStore, setWritesFail } = useFaultableSecureKeyMap();

let lastGeminiConstructorOpts: Record<string, unknown> | null = null;
const metadataUpserts: Array<{ service: string; field: string }> = [];
const metadataDeletes: Array<{ service: string; field: string }> = [];
let providerRefreshCalls = 0;
let identitySyncCalls = 0;
let avatarSyncCalls = 0;

const CLOUD_BASE_URL = "https://platform.example.com";
const ASSISTANT_API_KEY_PATH = credentialKey("cadet", "assistant_api_key");
const MANAGED_PROVIDERS = [
  "anthropic",
  "openai",
  "gemini",
  "fireworks",
  "together",
  "typesafe",
] as const;

let cloudAssistantIdOverride: string | undefined;
let cloudOrganizationIdOverride: string | undefined;
let platformUserIdOverride: string | undefined;

mock.module("@google/genai", () => ({
  GoogleGenAI: class MockGoogleGenAI {
    constructor(opts: Record<string, unknown>) {
      lastGeminiConstructorOpts = opts;
    }
    models = {
      generateContentStream: async () => ({
        [Symbol.asyncIterator]: async function* () {
          /* no chunks */
        },
      }),
    };
  },
  ApiError: class FakeApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
      this.name = "ApiError";
    }
  },
}));

mock.module("../config/env.js", () => ({
  getCloudBaseUrl: () => CLOUD_BASE_URL,
  getCloudAssistantId: () => cloudAssistantIdOverride,
  setCloudAssistantId: (value: string | undefined) => {
    cloudAssistantIdOverride = value;
  },
  setCloudOrganizationId: (value: string | undefined) => {
    cloudOrganizationIdOverride = value;
  },
  setCloudUserId: (value: string | undefined) => {
    platformUserIdOverride = value;
  },
}));

mock.module("../providers/provider-secret-catalog.js", () => ({
  API_KEY_PROVIDERS: [
    "anthropic",
    "openai",
    "gemini",
    "fireworks",
    "openrouter",
  ],
}));

mock.module("../tools/credentials/metadata-store.js", () => ({
  assertMetadataWritable: () => {},
  upsertCredentialMetadata: (service: string, field: string) => {
    metadataUpserts.push({ service, field });
  },
  deleteCredentialMetadata: (service: string, field: string) => {
    metadataDeletes.push({ service, field });
  },
}));

// `handleAddSecret` fires this detached when a cloud-proxy credential lands —
// a v2-memory side effect outside this suite's provider-registry scope. Stub it
// to a no-op; its behavior is covered by boot-maintenance.test.ts.
mock.module("../plugins/defaults/memory/substrate/boot-maintenance.js", () => ({
  maybeReseedCapabilitiesAfterCloudCredential: async () => {},
}));

// Live platform registration (`cadet login` against a running assistant)
// must re-enqueue the name and avatar syncs that no-op'd at startup.
mock.module("../cloud/sync-identity.js", () => ({
  syncWorkspaceIdentityToPlatform: () => {
    identitySyncCalls++;
  },
}));
mock.module("../avatar/sync-avatar.js", () => ({
  syncAvatarToCloud: () => {
    avatarSyncCalls++;
  },
}));

// secret-routes evicts conversations after a credential change so the next turn
// rebuilds against the new providers; count the calls to assert that happens.
mock.module("../daemon/conversation-store.js", () => ({
  evictConversationsForReload: () => {
    providerRefreshCalls++;
  },
}));

import { initializeDb } from "../persistence/db-init.js";
import {
  getProviderRoutingSource,
  initializeProviders,
  listProviders,
} from "../providers/registry.js";
import {
  notifyCesOfAssistantApiKeyUpdate,
  ROUTES,
} from "../runtime/routes/secret-routes.js";

// A delete looks up the provider connections that resolve their auth through
// the credential, so the inference schema has to exist. No connection is
// created here: the refusal is covered by
// runtime/routes/__tests__/credential-delete-in-use.test.ts.
await initializeDb();

const addRoute = ROUTES.find(
  (r) => r.method === "POST" && r.endpoint === "secrets",
)!;

const deleteRoute = ROUTES.find(
  (r) => r.method === "DELETE" && r.endpoint === "secrets",
)!;

function addCredential(name: string, value: string) {
  return addRoute.handler({
    body: { type: "credential", name, value },
  });
}

function deleteCredential(name: string) {
  return deleteRoute.handler({
    body: { type: "credential", name },
  });
}

function addApiKey(name: string, value: string) {
  return addRoute.handler({
    body: { type: "api_key", name, value },
  });
}

function deleteApiKey(name: string) {
  return deleteRoute.handler({
    body: { type: "api_key", name },
  });
}

describe("secret routes cloud proxy registry sync", () => {
  beforeEach(async () => {
    secureKeyStore.clear();
    setWritesFail(false);
    metadataUpserts.length = 0;
    metadataDeletes.length = 0;
    lastGeminiConstructorOpts = null;
    cloudAssistantIdOverride = undefined;
    cloudOrganizationIdOverride = undefined;
    platformUserIdOverride = undefined;
    providerRefreshCalls = 0;
    identitySyncCalls = 0;
    avatarSyncCalls = 0;
    setWritesFail(false);
    getDb()
      .delete(providerConnections)
      .where(eq(providerConnections.name, "openrouter-connection"))
      .run();
    await initializeProviders(getConfig());
  });

  test("adding cadet:assistant_api_key bootstraps cloud fallback providers immediately", async () => {
    expect(listProviders()).toEqual([]);

    const result = await addCredential(
      "cadet:assistant_api_key",
      "ast-managed-key",
    );

    expect(result).toEqual(expect.objectContaining({ success: true }));
    expect(secureKeyStore.get(ASSISTANT_API_KEY_PATH)).toBe("ast-managed-key");
    expect(metadataUpserts).toEqual([
      { service: "cadet", field: "assistant_api_key" },
    ]);

    const providers = listProviders();
    expect(providers).toHaveLength(MANAGED_PROVIDERS.length);
    for (const provider of MANAGED_PROVIDERS) {
      expect(providers).toContain(provider);
      expect(getProviderRoutingSource(provider)).toBe("cloud-proxy");
    }
    expect(lastGeminiConstructorOpts).toBeDefined();
  });

  test("the CES key-update notification with no CES client logs a warning", async () => {
    // When getCesClient() is undefined the push is skipped, but the skip must
    // be logged, not dropped silently. Exercise the extracted helper directly
    // with an injected logger.
    const warns: string[] = [];
    const fakeLogger = {
      info: () => {},
      warn: (a: unknown, b?: unknown) => {
        warns.push(typeof a === "string" ? a : String(b));
      },
    };

    await notifyCesOfAssistantApiKeyUpdate(
      "ast-managed-key",
      undefined,
      fakeLogger as unknown as Parameters<
        typeof notifyCesOfAssistantApiKeyUpdate
      >[2],
    );

    expect(warns.some((m) => m.includes("no CES client is connected"))).toBe(
      true,
    );
  });

  test("provider API key writes notify live-conversation refresh listeners", async () => {
    await addApiKey("fireworks", "fw-key");

    expect(secureKeyStore.get(credentialKey("fireworks", "api_key"))).toBe(
      "fw-key",
    );
    expect(providerRefreshCalls).toBe(1);

    await deleteApiKey("fireworks");

    expect(providerRefreshCalls).toBe(2);
  });

  test("deleting a cadet credential is rejected without touching the vault", async () => {
    secureKeyStore.set(ASSISTANT_API_KEY_PATH, "ast-managed-key");
    cloudAssistantIdOverride = "asst-1";
    await initializeProviders(getConfig());

    for (const name of [
      "cadet:assistant_api_key",
      "cadet:webhook_secret",
      "cadet:platform_assistant_id",
    ]) {
      await expect(deleteCredential(name)).rejects.toThrow(
        "Cadet credentials cannot be deleted",
      );
    }

    expect(secureKeyStore.get(ASSISTANT_API_KEY_PATH)).toBe("ast-managed-key");
    expect(cloudAssistantIdOverride).toBe("asst-1");
    expect(metadataDeletes).toEqual([]);
    expect(providerRefreshCalls).toBe(0);
  });

  test("cloud proxy credential writes notify live-conversation refresh listeners", async () => {
    await addCredential("cadet:assistant_api_key", "ast-managed-key");

    expect(providerRefreshCalls).toBe(1);
  });

  /**
   * Verifies that rotating a credential refreshes providers for dependent connections.
   */
  test("non-cloud credentials refresh providers when a connection uses them", async () => {
    // GIVEN a non-cloud credential.
    // AND a provider connection references its canonical credential key.
    const now = Date.now();
    getDb()
      .insert(providerConnections)
      .values({
        name: "openrouter-connection",
        provider: "openai",
        auth: JSON.stringify({
          type: "api_key",
          credential: credentialKey("openrouter", "api_key"),
        }),
        createdAt: now,
        updatedAt: now,
      })
      .run();

    // WHEN the credential is rotated.
    await addCredential("openrouter:api_key", "openrouter-key");

    // THEN the provider refresh runs once.
    expect(providerRefreshCalls).toBe(1);
  });

  /**
   * Verifies that rotating an unused credential does not refresh providers.
   */
  test("non-cloud credentials do not refresh providers when no connection uses them", async () => {
    // GIVEN a non-cloud credential.
    // AND no provider connection references its credential key.
    // WHEN the credential is rotated.
    await addCredential("openrouter:api_key", "openrouter-key");

    // THEN the provider refresh does not run.
    expect(providerRefreshCalls).toBe(0);
  });

  test("storing a cloud registration credential enqueues name and avatar syncs", async () => {
    await addCredential("cadet:assistant_api_key", "value");

    expect(identitySyncCalls).toBe(1);
    expect(avatarSyncCalls).toBe(1);
  });

  test("unrelated credentials do not enqueue platform syncs", async () => {
    await addCredential("openrouter:api_key", "openrouter-key");

    expect(identitySyncCalls).toBe(0);
    expect(avatarSyncCalls).toBe(0);
  });

  test("a failed cloud credential write does not enqueue platform syncs", async () => {
    setWritesFail(true);

    await expect(
      addCredential("cadet:assistant_api_key", "ast-managed-key"),
    ).rejects.toThrow("Failed to store credential");

    expect(identitySyncCalls).toBe(0);
    expect(avatarSyncCalls).toBe(0);
  });

  test("unknown cadet credentials are rejected without persisting or binding identity", async () => {
    cloudAssistantIdOverride = "existing-asst";
    cloudOrganizationIdOverride = "existing-org";
    platformUserIdOverride = "existing-user";

    await expect(
      addCredential("cadet:platform_assistant_id", "asst-1"),
    ).rejects.toThrow("Unknown cadet credential: platform_assistant_id");
    await expect(
      addCredential("cadet:platform_organization_id", "org-1"),
    ).rejects.toThrow("Unknown cadet credential: platform_organization_id");
    await expect(
      addCredential("cadet:platform_user_id", "user-1"),
    ).rejects.toThrow("Unknown cadet credential: platform_user_id");
    await expect(
      addCredential("cadet:platform_base_url", "https://managed.example.com"),
    ).rejects.toThrow("Unknown cadet credential: platform_base_url");
    // The canonical cloud_* spellings are equally non-writable — identity
    // credentials are provisioned by the cloud, never by the runtime.
    await expect(
      addCredential("cadet:cloud_assistant_id", "asst-1"),
    ).rejects.toThrow("Unknown cadet credential: cloud_assistant_id");

    expect(
      secureKeyStore.get(credentialKey("cadet", "platform_assistant_id")),
    ).toBeUndefined();
    expect(
      secureKeyStore.get(credentialKey("cadet", "cloud_assistant_id")),
    ).toBeUndefined();
    expect(
      secureKeyStore.get(credentialKey("cadet", "platform_organization_id")),
    ).toBeUndefined();
    expect(
      secureKeyStore.get(credentialKey("cadet", "platform_user_id")),
    ).toBeUndefined();
    expect(
      secureKeyStore.get(credentialKey("cadet", "platform_base_url")),
    ).toBeUndefined();
    expect(metadataUpserts).toEqual([]);
    expect(cloudAssistantIdOverride).toBe("existing-asst");
    expect(cloudOrganizationIdOverride).toBe("existing-org");
    expect(platformUserIdOverride).toBe("existing-user");
    expect(identitySyncCalls).toBe(0);
    expect(avatarSyncCalls).toBe(0);
  });

  test("an unknown cadet credential does not delete leftover vault copies", async () => {
    const key = credentialKey("cadet", "platform_assistant_id");
    secureKeyStore.set(key, "leftover-asst");
    cloudAssistantIdOverride = "asst-1";

    await expect(
      addCredential("cadet:platform_assistant_id", "   "),
    ).rejects.toThrow("Unknown cadet credential: platform_assistant_id");

    expect(secureKeyStore.get(key)).toBe("leftover-asst");
    expect(cloudAssistantIdOverride).toBe("asst-1");
    expect(metadataDeletes).toEqual([]);
    expect(identitySyncCalls).toBe(0);
    expect(avatarSyncCalls).toBe(0);
  });

  test("storing cadet:assistant_api_key enables cloud proxy", async () => {
    expect(listProviders()).toEqual([]);

    await addCredential("cadet:assistant_api_key", "ast-managed-key");

    const providers = listProviders();
    expect(providers).toHaveLength(MANAGED_PROVIDERS.length);
    for (const provider of MANAGED_PROVIDERS) {
      expect(providers).toContain(provider);
      expect(getProviderRoutingSource(provider)).toBe("cloud-proxy");
    }
  });
});
