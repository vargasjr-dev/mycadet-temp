/**
 * Tests for platform credential filtering during bundle import.
 *
 * `migration-routes.ts` pushes every bundle credential through a filter that
 * must exclude cloud-identity (`cadet:*`) entries so they can't overwrite
 * the target's own Django-provisioned identity. The filter runs against the
 * raw CES account format — `credential/{service}/{field}` — produced by
 * `credentialKey()`, which is what `listSecureKeysAsync()` returns and what
 * `extractCredentialsFromBundle` surfaces back as `account`.
 *
 * The constant is duplicated here (rather than imported) because
 * `migration-routes.ts` has heavy transitive imports that are expensive to
 * resolve in a test and would require wide mocking. Instead we bind the two
 * copies with a regression assertion: if `credentialKey()`'s output format
 * changes, the `startsWith(...)` prefix must change in lockstep. That
 * regression is explicit at the bottom of this file.
 *
 * Covered:
 * - Platform (cadet:*) credentials stored under the real `credential/cadet/...`
 *   key format are excluded.
 * - User credentials (any other prefix) pass through unchanged.
 * - Mixed bundles correctly split platform vs user credentials.
 * - skippedPlatform count matches the number of excluded entries.
 * - Regression: the prefix constant matches `credentialKey("cadet", "")`.
 */

import { describe, expect, test } from "bun:test";

import { credentialKey } from "../../../security/credential-key.js";
import { extractCredentialsFromBundle } from "../../migrations/vbundle-importer.js";
import type {
  ManifestType,
  VBundleTarEntry,
} from "../../migrations/vbundle-validator.js";

// ---------------------------------------------------------------------------
// The same constant used by migration-routes.ts — kept in sync via the
// regression assertion at the bottom of this file.
// ---------------------------------------------------------------------------

const PLATFORM_CREDENTIAL_PREFIX = credentialKey("cadet", "");

// ---------------------------------------------------------------------------
// Helpers (same pattern as vbundle-import-credentials.test.ts)
// ---------------------------------------------------------------------------

function makeTarEntry(data: string): VBundleTarEntry {
  const encoded = new TextEncoder().encode(data);
  return { name: "", data: encoded, size: encoded.length };
}

function makeManifest(paths: string[]): ManifestType {
  return {
    schema_version: 1,
    bundle_id: "00000000-0000-4000-8000-000000000000",
    created_at: new Date().toISOString(),
    assistant: { id: "self", name: "Test", runtime_version: "0.0.0-test" },
    origin: { mode: "self-hosted-local" },
    compatibility: {
      min_runtime_version: "0.0.0-test",
      max_runtime_version: null,
    },
    contents: paths.map((path) => ({
      path,
      size_bytes: 0,
      sha256: "test",
    })),
    checksum:
      "0000000000000000000000000000000000000000000000000000000000000000",
    secrets_redacted: false,
    export_options: {
      include_logs: false,
      include_browser_state: false,
      include_memory_vectors: false,
    },
  } as unknown as ManifestType;
}

/**
 * Build a bundle archive entry path for a credential whose CES account is
 * `account`. `vbundle-builder.ts` stores credentials under
 * `credentials/<account>`; the importer reverses that split.
 */
function bundlePathFor(account: string): string {
  return `credentials/${account}`;
}

/**
 * Simulate the filtering logic from migration-routes.ts:
 *
 *   const userCredentials = bundleCredentials.filter(
 *     (c) => !c.account.startsWith(PLATFORM_CREDENTIAL_PREFIX),
 *   );
 */
function filterCredentials(
  bundleCredentials: Array<{ account: string; value: string }>,
) {
  const userCredentials = bundleCredentials.filter(
    (c) => !c.account.startsWith(PLATFORM_CREDENTIAL_PREFIX),
  );
  const skippedPlatform = bundleCredentials.length - userCredentials.length;
  return { userCredentials, skippedPlatform };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("migration import credential filtering", () => {
  test("platform (cadet:*) credentials are excluded", () => {
    const cadetFields = [
      "assistant_api_key",
      "platform_assistant_id",
      "webhook_secret",
    ] as const;
    const cadetPaths = cadetFields.map((f) =>
      bundlePathFor(credentialKey("cadet", f)),
    );

    const entries = new Map<string, VBundleTarEntry>();
    for (const path of cadetPaths) {
      entries.set(path, makeTarEntry(`value-for-${path}`));
    }

    const manifest = makeManifest(cadetPaths);

    const bundleCredentials = extractCredentialsFromBundle(entries, manifest);
    const { userCredentials, skippedPlatform } =
      filterCredentials(bundleCredentials);

    expect(userCredentials).toHaveLength(0);
    expect(skippedPlatform).toBe(cadetFields.length);
  });

  test("user credentials pass through unchanged", () => {
    const openaiAccount = credentialKey("openai", "api_key");
    const anthropicAccount = credentialKey("anthropic", "api_key");

    const entries = new Map<string, VBundleTarEntry>();
    entries.set(bundlePathFor(openaiAccount), makeTarEntry("sk-user-123"));
    entries.set(bundlePathFor(anthropicAccount), makeTarEntry("sk-ant-456"));

    const manifest = makeManifest([
      bundlePathFor(openaiAccount),
      bundlePathFor(anthropicAccount),
    ]);

    const bundleCredentials = extractCredentialsFromBundle(entries, manifest);
    const { userCredentials, skippedPlatform } =
      filterCredentials(bundleCredentials);

    expect(userCredentials).toHaveLength(2);
    expect(userCredentials).toContainEqual({
      account: openaiAccount,
      value: "sk-user-123",
    });
    expect(userCredentials).toContainEqual({
      account: anthropicAccount,
      value: "sk-ant-456",
    });
    expect(skippedPlatform).toBe(0);
  });

  test("mixed bundle with both platform and user credentials correctly splits", () => {
    const cadetApiKey = credentialKey("cadet", "assistant_api_key");
    const cadetUserId = credentialKey("cadet", "platform_assistant_id");
    const openaiKey = credentialKey("openai", "api_key");
    const anthropicKey = credentialKey("anthropic", "api_key");
    const githubToken = credentialKey("github", "api_token");

    const entries = new Map<string, VBundleTarEntry>();
    entries.set(bundlePathFor(cadetApiKey), makeTarEntry("platform-key"));
    entries.set(bundlePathFor(cadetUserId), makeTarEntry("platform-user"));
    entries.set(bundlePathFor(openaiKey), makeTarEntry("sk-user-123"));
    entries.set(bundlePathFor(anthropicKey), makeTarEntry("sk-ant-456"));
    entries.set(bundlePathFor(githubToken), makeTarEntry("ghp-789"));

    const manifest = makeManifest([
      bundlePathFor(cadetApiKey),
      bundlePathFor(cadetUserId),
      bundlePathFor(openaiKey),
      bundlePathFor(anthropicKey),
      bundlePathFor(githubToken),
    ]);

    const bundleCredentials = extractCredentialsFromBundle(entries, manifest);
    const { userCredentials, skippedPlatform } =
      filterCredentials(bundleCredentials);

    // Only user credentials should pass through.
    expect(userCredentials).toHaveLength(3);
    const accounts = userCredentials.map((c) => c.account).sort();
    expect(accounts).toEqual([anthropicKey, githubToken, openaiKey].sort());

    // No platform credentials in the filtered output.
    const cadetCreds = userCredentials.filter((c) =>
      c.account.startsWith(PLATFORM_CREDENTIAL_PREFIX),
    );
    expect(cadetCreds).toHaveLength(0);

    expect(skippedPlatform).toBe(2);
  });

  test("skippedPlatform count is accurate with mixed credentials", () => {
    const cadetApiKey = credentialKey("cadet", "assistant_api_key");
    const cadetAssistantId = credentialKey("cadet", "platform_assistant_id");
    const cadetWebhook = credentialKey("cadet", "webhook_secret");
    const userKey = credentialKey("github", "api_token");

    const entries = new Map<string, VBundleTarEntry>();
    entries.set(bundlePathFor(cadetApiKey), makeTarEntry("v1"));
    entries.set(bundlePathFor(cadetAssistantId), makeTarEntry("v2"));
    entries.set(bundlePathFor(cadetWebhook), makeTarEntry("v3"));
    entries.set(bundlePathFor(userKey), makeTarEntry("user-val"));

    const manifest = makeManifest([
      bundlePathFor(cadetApiKey),
      bundlePathFor(cadetAssistantId),
      bundlePathFor(cadetWebhook),
      bundlePathFor(userKey),
    ]);

    const bundleCredentials = extractCredentialsFromBundle(entries, manifest);
    const { userCredentials, skippedPlatform } =
      filterCredentials(bundleCredentials);

    expect(skippedPlatform).toBe(3);
    expect(userCredentials).toHaveLength(1);
    expect(userCredentials[0]).toEqual({
      account: userKey,
      value: "user-val",
    });

    // Verify total = user + skipped
    expect(bundleCredentials.length).toBe(
      userCredentials.length + skippedPlatform,
    );
  });

  test("regression: the prefix matches credentialKey('cadet', '') so format changes propagate", () => {
    // If credentialKey()'s format ever changes (e.g. slash → something else),
    // this assertion will fail and the duplicated constant in
    // migration-routes.ts must be updated to stay in sync.
    expect(PLATFORM_CREDENTIAL_PREFIX).toBe("credential/cadet/");
    expect(
      credentialKey("cadet", "assistant_api_key").startsWith(
        PLATFORM_CREDENTIAL_PREFIX,
      ),
    ).toBe(true);

    // The raw "cadet:" string is not a valid CES account prefix — only
    // the full "credential/cadet/" format from credentialKey() is correct.
    expect(
      credentialKey("cadet", "assistant_api_key").startsWith("cadet:"),
    ).toBe(false);
  });
});
