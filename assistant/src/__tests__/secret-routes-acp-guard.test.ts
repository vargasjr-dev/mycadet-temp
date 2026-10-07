import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  ACP_OAUTH_EXPIRES_AT_FIELD,
  ACP_OAUTH_REFRESH_TOKEN_FIELD,
  ACP_OAUTH_TOKEN_FIELD,
  ACP_SERVICE,
} from "../acp/acp-credentials.js";
import { credentialKey } from "../security/credential-key.js";
import { useMemorySecureKeys } from "./helpers/secure-keys.js";

// The REAL secure-keys module pinned to a live memory backend — the tests
// index the store directly, same as the old inline fake did.
const secureKeyStore = useMemorySecureKeys();

mock.module("../tools/credentials/metadata-store.js", () => ({
  assertMetadataWritable: () => {},
  upsertCredentialMetadata: () => {},
  deleteCredentialMetadata: () => {},
}));

mock.module("../oauth/manual-token-connection.js", () => ({
  syncManualTokenConnection: async () => {},
}));

mock.module("../runtime/routes/credential-in-use.js", () => ({
  assertCredentialNotInUse: () => [],
  invalidateConnectionsAfterCredentialDelete: () => {},
}));

afterAll(() => {
  mock.restore();
});

import { BadRequestError } from "../runtime/routes/errors.js";
import { ROUTES } from "../runtime/routes/secret-routes.js";

const addRoute = ROUTES.find(
  (r) => r.method === "POST" && r.endpoint === "secrets",
)!;
const deleteRoute = ROUTES.find(
  (r) => r.method === "DELETE" && r.endpoint === "secrets",
)!;

function addAcpOauthToken(value: string) {
  return addRoute.handler({
    body: {
      type: "credential",
      name: `${ACP_SERVICE}:${ACP_OAUTH_TOKEN_FIELD}`,
      value,
    },
  });
}

describe("secret routes ACP OAuth-token format guard", () => {
  beforeEach(() => {
    for (const k of Object.keys(secureKeyStore)) {
      delete secureKeyStore[k];
    }
  });

  test("rejects an Anthropic API key with a 400 and does not persist it", async () => {
    await expect(
      addAcpOauthToken("sk-ant-api03-not-an-oauth-token"),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(
      secureKeyStore[credentialKey(ACP_SERVICE, ACP_OAUTH_TOKEN_FIELD)],
    ).toBeUndefined();
  });

  test("accepts a Claude OAuth token", async () => {
    const result = await addAcpOauthToken("sk-ant-oat01-valid-oauth-token");
    expect(result).toEqual(expect.objectContaining({ success: true }));
    expect(
      secureKeyStore[credentialKey(ACP_SERVICE, ACP_OAUTH_TOKEN_FIELD)],
    ).toBe("sk-ant-oat01-valid-oauth-token");
  });

  test("stores a pasted Claude token without touching leftover refresh material", async () => {
    secureKeyStore[credentialKey(ACP_SERVICE, ACP_OAUTH_REFRESH_TOKEN_FIELD)] =
      "stale-refresh";
    secureKeyStore[credentialKey(ACP_SERVICE, ACP_OAUTH_EXPIRES_AT_FIELD)] =
      "111";

    await addAcpOauthToken("sk-ant-oat01-pasted-token");

    expect(
      secureKeyStore[credentialKey(ACP_SERVICE, ACP_OAUTH_TOKEN_FIELD)],
    ).toBe("sk-ant-oat01-pasted-token");
    expect(
      secureKeyStore[credentialKey(ACP_SERVICE, ACP_OAUTH_REFRESH_TOKEN_FIELD)],
    ).toBe("stale-refresh");
    expect(
      secureKeyStore[credentialKey(ACP_SERVICE, ACP_OAUTH_EXPIRES_AT_FIELD)],
    ).toBe("111");
  });

  test("deletes only the requested Claude access-token field", async () => {
    secureKeyStore[credentialKey(ACP_SERVICE, ACP_OAUTH_TOKEN_FIELD)] =
      "sk-ant-oat01-connected";
    secureKeyStore[credentialKey(ACP_SERVICE, ACP_OAUTH_REFRESH_TOKEN_FIELD)] =
      "refresh-leftover";
    secureKeyStore[credentialKey(ACP_SERVICE, ACP_OAUTH_EXPIRES_AT_FIELD)] =
      "111";

    await deleteRoute.handler({
      body: {
        type: "credential",
        name: `${ACP_SERVICE}:${ACP_OAUTH_TOKEN_FIELD}`,
      },
    });

    expect(
      secureKeyStore[credentialKey(ACP_SERVICE, ACP_OAUTH_TOKEN_FIELD)],
    ).toBeUndefined();
    expect(
      secureKeyStore[credentialKey(ACP_SERVICE, ACP_OAUTH_REFRESH_TOKEN_FIELD)],
    ).toBe("refresh-leftover");
    expect(
      secureKeyStore[credentialKey(ACP_SERVICE, ACP_OAUTH_EXPIRES_AT_FIELD)],
    ).toBe("111");
  });
});
