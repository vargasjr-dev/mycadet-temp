/**
 * Tests for the post-import cadet metadata reconciliation helper.
 *
 * After every bundle import, `reconcileCadetMetadataFromCes` walks the
 * cadet credentials the gateway requires and, for each one that
 * CES already holds a value for, ensures `metadata.json` lists a
 * matching entry. This closes the race where a provisioning write to
 * CES completes successfully but its metadata upsert gets clobbered by
 * the import's in-place clear or atomic swap. The reconciled set covers
 * the Django-provisioned credentials (assistant_api_key, webhook_secret).
 *
 * We test the reconcile logic in isolation by mocking the secure-keys
 * and metadata-store modules — the real migration handler wires the
 * same imports, so the behavior under test matches production.
 *
 * Covered:
 * - CES has all 6 fields + metadata empty → all 6 upserted.
 * - CES has all 6 + metadata has 2 → only the missing 4 upserted.
 * - CES has no values → nothing upserted.
 * - CES has values + metadata already has them → no-op (no duplicate
 *   upserts).
 * - upsert throws for one field → warning recorded, loop continues.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { credentialKey } from "../../../security/credential-key.js";
import * as actualMetadataStore from "../../../tools/credentials/metadata-store.js";

type MetadataRecord = {
  credentialId: string;
  service: string;
  field: string;
  allowedTools: string[];
  allowedDomains: string[];
  createdAt: number;
  updatedAt: number;
};

const CADET_FIELDS = ["assistant_api_key", "webhook_secret"] as const;

const upsertCalls: Array<{ service: string; field: string }> = [];
let metadataStore: Map<string, MetadataRecord> = new Map();
let upsertImpl: (service: string, field: string) => void = (service, field) => {
  const key = `${service}:${field}`;
  metadataStore.set(key, {
    credentialId: `id-${key}`,
    service,
    field,
    allowedTools: [],
    allowedDomains: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
};

// The REAL secure-keys module pinned to a live memory backend; the reconcile
// reads getSecureKeyAsync(cadet credential keys), which the store serves.
import { useMemorySecureKeyMap } from "../../../__tests__/helpers/secure-keys.js";

const cesValues = useMemorySecureKeyMap();

// Spread the real module so every export the reconcile handler's transitive
// graph links (e.g. getCredentialMetadataById, listCredentialMetadata pulled in
// via the plugin-api hub) stays present; only the two functions under test are
// overridden. A partial mock replaces the whole namespace and fails to link the
// unlisted exports.
mock.module("../../../tools/credentials/metadata-store.js", () => ({
  ...actualMetadataStore,
  getCredentialMetadata: (service: string, field: string) =>
    metadataStore.get(`${service}:${field}`),
  upsertCredentialMetadata: (
    service: string,
    field: string,
    _policy?: unknown,
  ) => {
    upsertCalls.push({ service, field });
    upsertImpl(service, field);
    return metadataStore.get(`${service}:${field}`);
  },
}));

// Import under test AFTER the mocks are set up.
const { reconcileCadetMetadataFromCes } =
  (await import("../migration-routes.js")) as unknown as {
    reconcileCadetMetadataFromCes: (sink: {
      warnings: string[];
    }) => Promise<void>;
  };

beforeEach(() => {
  upsertCalls.length = 0;
  metadataStore = new Map();
  cesValues.clear();
  upsertImpl = (service, field) => {
    const key = `${service}:${field}`;
    metadataStore.set(key, {
      credentialId: `id-${key}`,
      service,
      field,
      allowedTools: [],
      allowedDomains: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  };
});

afterEach(() => {
  upsertCalls.length = 0;
});

function seedAllInCes(): void {
  for (const field of CADET_FIELDS) {
    cesValues.set(credentialKey("cadet", field), `value-for-${field}`);
  }
}

describe("reconcileCadetMetadataFromCes", () => {
  test("CES holds all fields, metadata empty → all upserted", async () => {
    seedAllInCes();
    const sink = { warnings: [] as string[] };

    await reconcileCadetMetadataFromCes(sink);

    expect(upsertCalls).toHaveLength(CADET_FIELDS.length);
    expect(new Set(upsertCalls.map((c) => c.field))).toEqual(
      new Set(CADET_FIELDS),
    );
    expect(sink.warnings).toHaveLength(0);
  });

  test("CES holds all, metadata has 2 → only the missing ones upserted", async () => {
    seedAllInCes();
    // Pre-populate metadata for 2 of the fields.
    const prepopulated = ["assistant_api_key", "webhook_secret"] as const;
    for (const field of prepopulated) {
      metadataStore.set(`cadet:${field}`, {
        credentialId: `id-cadet:${field}`,
        service: "cadet",
        field,
        allowedTools: [],
        allowedDomains: [],
        createdAt: 1,
        updatedAt: 1,
      });
    }

    const sink = { warnings: [] as string[] };
    await reconcileCadetMetadataFromCes(sink);

    const expectedMissing = CADET_FIELDS.filter(
      (f) => !(prepopulated as readonly string[]).includes(f),
    );
    expect(upsertCalls).toHaveLength(expectedMissing.length);
    expect(new Set(upsertCalls.map((c) => c.field))).toEqual(
      new Set(expectedMissing),
    );
  });

  test("covers both Django-provisioned and client-injected identity fields", async () => {
    seedAllInCes();
    const sink = { warnings: [] as string[] };
    await reconcileCadetMetadataFromCes(sink);

    const reconciled = new Set(upsertCalls.map((c) => c.field));
    // Django-provisioned trio.
    expect(reconciled).toContain("assistant_api_key");
    expect(reconciled).toContain("webhook_secret");
  });

  test("CES empty → nothing upserted", async () => {
    const sink = { warnings: [] as string[] };
    await reconcileCadetMetadataFromCes(sink);
    expect(upsertCalls).toHaveLength(0);
    expect(sink.warnings).toHaveLength(0);
  });

  test("CES has values, metadata already has entries → no duplicate upserts", async () => {
    seedAllInCes();
    for (const field of CADET_FIELDS) {
      metadataStore.set(`cadet:${field}`, {
        credentialId: `id-cadet:${field}`,
        service: "cadet",
        field,
        allowedTools: [],
        allowedDomains: [],
        createdAt: 1,
        updatedAt: 1,
      });
    }

    const sink = { warnings: [] as string[] };
    await reconcileCadetMetadataFromCes(sink);

    expect(upsertCalls).toHaveLength(0);
  });

  test("upsert throws for one field → warning recorded, loop continues", async () => {
    seedAllInCes();
    let calls = 0;
    upsertImpl = (service, field) => {
      calls += 1;
      if (field === "assistant_api_key") {
        throw new Error("simulated metadata write failure");
      }
      const key = `${service}:${field}`;
      metadataStore.set(key, {
        credentialId: `id-${key}`,
        service,
        field,
        allowedTools: [],
        allowedDomains: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    };

    const sink = { warnings: [] as string[] };
    await reconcileCadetMetadataFromCes(sink);

    // Every field was attempted (loop did not abort).
    expect(calls).toBe(CADET_FIELDS.length);
    expect(sink.warnings).toHaveLength(1);
    expect(sink.warnings[0]).toContain("cadet:assistant_api_key");
  });
});
