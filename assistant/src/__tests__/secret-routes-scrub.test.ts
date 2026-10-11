/**
 * secrets_add (api_key) transcript-scrub seam.
 *
 * A provider API key stored via `assistant keys set` / the secrets API may
 * already sit in recent transcripts. Validates that the route:
 *   - scrubs the stored value exactly once, immediately after the
 *     secure-store write
 *   - never scrubs when validation rejects the request (nothing was stored)
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mutable mock state (closed over by the mock factories below)
// ---------------------------------------------------------------------------
import { useMemorySecureKeyMap } from "./helpers/secure-keys.js";

// The REAL secure-keys module pinned to a live memory backend — same Map
// semantics the old inline fake reimplemented.
const secureStore = useMemorySecureKeyMap();

let scrubbedValues: string[];
let anthropicKeyValid: boolean;
let providersRefreshed: number;

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

mock.module("../daemon/credential-transcript-scrub.js", () => ({
  scrubStoredCredentialFromTranscripts: mock(async (value: string) => {
    scrubbedValues.push(value);
    return { dbMessagesScrubbed: 0, residentMessagesScrubbed: 0 };
  }),
}));

mock.module("../providers/anthropic/client.js", () => ({
  validateAnthropicApiKey: mock(async () =>
    anthropicKeyValid
      ? { valid: true }
      : { valid: false, reason: "Invalid API key" },
  ),
}));

// Collaborators of refreshProvidersAfterSecretChange — stubbed so the api_key
// flow runs without a live config/provider/conversation graph.
mock.module("../config/loader.js", () => ({
  getConfig: () => ({}),
  invalidateConfigCache: () => {},
}));
mock.module("../providers/registry.js", () => ({
  initializeProviders: mock(async () => {
    providersRefreshed++;
  }),
}));
mock.module("../persistence/embeddings/embedding-backend.js", () => ({
  clearEmbeddingBackendCache: () => {},
}));
mock.module("../daemon/conversation-store.js", () => ({
  evictConversationsForReload: () => {},
}));

// Collaborators of the `credential` branch — stubbed so credential stores run
// without live metadata/oauth/platform-env state.
mock.module("../tools/credentials/metadata-store.js", () => ({
  assertMetadataWritable: () => {},
  upsertCredentialMetadata: () => {},
  deleteCredentialMetadata: () => {},
}));
mock.module("../oauth/manual-token-connection.js", () => ({
  syncManualTokenConnection: mock(async () => {}),
}));
import { BadRequestError } from "../runtime/routes/errors.js";
import { ROUTES } from "../runtime/routes/secret-routes.js";
import { credentialKey } from "../security/credential-key.js";

const addRoute = ROUTES.find((r) => r.operationId === "secrets_add")!;

const API_KEY_VALUE = "test-api-key-value-1234567890";

describe("secrets_add api_key transcript scrub", () => {
  beforeEach(() => {
    secureStore.clear();
    scrubbedValues = [];
    anthropicKeyValid = true;
    providersRefreshed = 0;
  });

  test("a successful api_key set scrubs the stored value exactly once", async () => {
    const result = await addRoute.handler({
      body: { type: "api_key", name: "fireworks", value: API_KEY_VALUE },
    });

    expect(result).toEqual(
      expect.objectContaining({ success: true, name: "fireworks" }),
    );
    expect(secureStore.get(credentialKey("fireworks", "api_key"))).toBe(
      API_KEY_VALUE,
    );
    expect(scrubbedValues).toEqual([API_KEY_VALUE]);
    // The provider refresh still happens after the scrub.
    expect(providersRefreshed).toBe(1);
  });

  test("an unknown provider is rejected and never triggers a scrub", async () => {
    await expect(
      addRoute.handler({
        body: {
          type: "api_key",
          name: "not-a-real-provider",
          value: API_KEY_VALUE,
        },
      }),
    ).rejects.toBeInstanceOf(BadRequestError);

    expect(secureStore.size).toBe(0);
    expect(scrubbedValues).toEqual([]);
  });

  test("a provider-validation failure stores nothing and never triggers a scrub", async () => {
    anthropicKeyValid = false;

    const result = await addRoute.handler({
      body: { type: "api_key", name: "anthropic", value: API_KEY_VALUE },
    });

    expect(result).toEqual(
      expect.objectContaining({ success: false, error: "Invalid API key" }),
    );
    expect(secureStore.size).toBe(0);
    expect(scrubbedValues).toEqual([]);
  });
});

const CREDENTIAL_VALUE = "synthetic-credential-value-0987654321";

describe("secrets_add credential transcript scrub", () => {
  beforeEach(() => {
    secureStore.clear();
    scrubbedValues = [];
    anthropicKeyValid = true;
    providersRefreshed = 0;
  });

  test("a successful credential set scrubs the stored value exactly once", async () => {
    const result = await addRoute.handler({
      body: {
        type: "credential",
        name: "github:api_token",
        value: CREDENTIAL_VALUE,
      },
    });

    expect(result).toEqual(expect.objectContaining({ success: true }));
    expect(secureStore.get(credentialKey("github", "api_token"))).toBe(
      CREDENTIAL_VALUE,
    );
    expect(scrubbedValues).toEqual([CREDENTIAL_VALUE]);
  });

  test("an unknown cadet credential is rejected and never triggers a scrub", async () => {
    await expect(
      addRoute.handler({
        body: {
          type: "credential",
          name: "cadet:platform_assistant_id",
          value: "   ",
        },
      }),
    ).rejects.toBeInstanceOf(BadRequestError);

    expect(secureStore.size).toBe(0);
    expect(scrubbedValues).toEqual([]);
  });

  test("a malformed credential name is rejected and never triggers a scrub", async () => {
    await expect(
      addRoute.handler({
        body: {
          type: "credential",
          name: "no-colon-here",
          value: CREDENTIAL_VALUE,
        },
      }),
    ).rejects.toBeInstanceOf(BadRequestError);

    expect(secureStore.size).toBe(0);
    expect(scrubbedValues).toEqual([]);
  });
});
