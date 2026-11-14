import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";

import {
  assertMetadataWritable,
  deleteCredentialMetadata,
  getCredentialMetadata,
  getCredentialMetadataById,
  listCredentialMetadata,
  upsertCredentialMetadata,
  _resetCredentialMetadataCacheForTests,
} from "../tools/credentials/metadata-store.js";
import type { CredentialInjectionTemplate } from "../tools/credentials/policy-types.js";

beforeEach(() => {
  _resetCredentialMetadataCacheForTests();
});

describe("credential metadata store", () => {
  // ── Create ──────────────────────────────────────────────────────────

  describe("upsertCredentialMetadata", () => {
    test("creates new record with generated ID", () => {
      const record = upsertCredentialMetadata("github", "token", {
        allowedTools: ["browser_fill_credential"],
        allowedDomains: ["github.com"],
        usageDescription: "GitHub login",
      });

      expect(record.credentialId).toBeTruthy();
      expect(record.service).toBe("github");
      expect(record.field).toBe("token");
      expect(record.allowedTools).toEqual(["browser_fill_credential"]);
      expect(record.allowedDomains).toEqual(["github.com"]);
      expect(record.usageDescription).toBe("GitHub login");
      expect(record.createdAt).toBeGreaterThan(0);
      expect(record.updatedAt).toBe(record.createdAt);
    });

    test("defaults policy arrays to empty", () => {
      const record = upsertCredentialMetadata("gmail", "password");
      expect(record.allowedTools).toEqual([]);
      expect(record.allowedDomains).toEqual([]);
      expect(record.usageDescription).toBeUndefined();
    });

    test("updates existing record by service+field", () => {
      const created = upsertCredentialMetadata("github", "token", {
        allowedTools: ["browser_fill_credential"],
      });

      const updated = upsertCredentialMetadata("github", "token", {
        allowedDomains: ["github.com"],
        usageDescription: "Updated purpose",
      });

      expect(updated.credentialId).toBe(created.credentialId);
      expect(updated.allowedTools).toEqual(["browser_fill_credential"]);
      expect(updated.allowedDomains).toEqual(["github.com"]);
      expect(updated.usageDescription).toBe("Updated purpose");
      expect(updated.updatedAt).toBeGreaterThanOrEqual(created.createdAt);
    });
  });

  // ── Read ────────────────────────────────────────────────────────────

  describe("getCredentialMetadata", () => {
    test("returns metadata by service+field", () => {
      upsertCredentialMetadata("github", "token");
      const result = getCredentialMetadata("github", "token");
      expect(result).toBeDefined();
      expect(result!.service).toBe("github");
    });

    test("returns undefined for non-existent credential", () => {
      expect(getCredentialMetadata("nonexistent", "field")).toBeUndefined();
    });
  });

  describe("getCredentialMetadataById", () => {
    test("returns metadata by credentialId", () => {
      const created = upsertCredentialMetadata("github", "token");
      const result = getCredentialMetadataById(created.credentialId);
      expect(result).toBeDefined();
      expect(result!.service).toBe("github");
    });

    test("returns undefined for non-existent ID", () => {
      expect(getCredentialMetadataById("non-existent-id")).toBeUndefined();
    });
  });

  // ── List ────────────────────────────────────────────────────────────

  describe("listCredentialMetadata", () => {
    test("returns all credentials", () => {
      upsertCredentialMetadata("github", "token");
      upsertCredentialMetadata("gmail", "password");
      const list = listCredentialMetadata();
      expect(list).toHaveLength(2);
    });

    test("returns empty array when no credentials exist", () => {
      expect(listCredentialMetadata()).toEqual([]);
    });
  });

  // ── Delete ──────────────────────────────────────────────────────────

  describe("deleteCredentialMetadata", () => {
    test("deletes existing metadata", () => {
      upsertCredentialMetadata("github", "token");
      expect(deleteCredentialMetadata("github", "token")).toBe(true);
      expect(getCredentialMetadata("github", "token")).toBeUndefined();
    });

    test("returns false for non-existent credential", () => {
      expect(deleteCredentialMetadata("nonexistent", "field")).toBe(false);
    });
  });

  // ── Persistence ─────────────────────────────────────────────────────

  describe("persistence", () => {
    test("metadata survives across calls (in-process cache)", () => {
      upsertCredentialMetadata("github", "token", {
        allowedTools: ["browser_fill_credential"],
      });

      // Read again — the in-process cache is the assistant-side view of
      // CES-owned records; durable state lives in CES.
      const result = getCredentialMetadata("github", "token");
      expect(result).toBeDefined();
      expect(result!.allowedTools).toEqual(["browser_fill_credential"]);
    });
  });

  // ── No secret values ───────────────────────────────────────────────

  describe("security", () => {
    test("metadata records never contain secret values", () => {
      const record = upsertCredentialMetadata("github", "token", {
        allowedTools: ["browser_fill_credential"],
      });

      const keys = Object.keys(record);
      expect(keys).not.toContain("value");
      expect(keys).not.toContain("password");
      expect(JSON.stringify(record)).not.toContain("secret");
    });
  });

  // ── v2 Schema: alias + injectionTemplates ──────────────────────────

  describe("v2 schema — alias and injectionTemplates", () => {
    const falInjection: CredentialInjectionTemplate = {
      hostPattern: "*.fal.ai",
      injectionType: "header",
      headerName: "Authorization",
      valuePrefix: "Key ",
    };

    const queryInjection: CredentialInjectionTemplate = {
      hostPattern: "maps.example.com",
      injectionType: "query",
      queryParamName: "key",
    };

    test("creates record with alias", () => {
      const record = upsertCredentialMetadata("fal-ai", "api_key", {
        alias: "fal-primary",
        allowedTools: ["api_request"],
      });
      expect(record.alias).toBe("fal-primary");
    });

    test("creates record with injectionTemplates", () => {
      const record = upsertCredentialMetadata("fal-ai", "api_key", {
        injectionTemplates: [falInjection],
      });
      expect(record.injectionTemplates).toEqual([falInjection]);
    });

    test("creates record with multiple injection templates", () => {
      const record = upsertCredentialMetadata("multi", "key", {
        injectionTemplates: [falInjection, queryInjection],
      });
      expect(record.injectionTemplates).toHaveLength(2);
      expect(record.injectionTemplates![0].injectionType).toBe("header");
      expect(record.injectionTemplates![1].injectionType).toBe("query");
    });

    test("creates record with alias and injectionTemplates together", () => {
      const record = upsertCredentialMetadata("fal-ai", "api_key", {
        alias: "fal-primary",
        allowedDomains: ["fal.ai"],
        injectionTemplates: [falInjection],
      });
      expect(record.alias).toBe("fal-primary");
      expect(record.injectionTemplates).toEqual([falInjection]);
      expect(record.allowedDomains).toEqual(["fal.ai"]);
    });

    test("defaults alias and injectionTemplates to undefined when not provided", () => {
      const record = upsertCredentialMetadata("basic", "token");
      expect(record.alias).toBeUndefined();
      expect(record.injectionTemplates).toBeUndefined();
    });

    test("updates alias on existing record", () => {
      upsertCredentialMetadata("fal-ai", "api_key", { alias: "fal-old" });
      const updated = upsertCredentialMetadata("fal-ai", "api_key", {
        alias: "fal-new",
      });
      expect(updated.alias).toBe("fal-new");
    });

    test("clears alias with null", () => {
      upsertCredentialMetadata("fal-ai", "api_key", { alias: "fal-primary" });
      const updated = upsertCredentialMetadata("fal-ai", "api_key", {
        alias: null,
      });
      expect(updated.alias).toBeUndefined();
    });

    test("updates injectionTemplates on existing record", () => {
      upsertCredentialMetadata("fal-ai", "api_key", {
        injectionTemplates: [falInjection],
      });
      const updated = upsertCredentialMetadata("fal-ai", "api_key", {
        injectionTemplates: [queryInjection],
      });
      expect(updated.injectionTemplates).toEqual([queryInjection]);
    });

    test("clears injectionTemplates with null", () => {
      upsertCredentialMetadata("fal-ai", "api_key", {
        injectionTemplates: [falInjection],
      });
      const updated = upsertCredentialMetadata("fal-ai", "api_key", {
        injectionTemplates: null,
      });
      expect(updated.injectionTemplates).toBeUndefined();
    });

    test("round-trip: alias and templates survive serialization", () => {
      upsertCredentialMetadata("fal-ai", "api_key", {
        alias: "fal-primary",
        allowedTools: ["api_request"],
        allowedDomains: ["fal.ai"],
        injectionTemplates: [falInjection],
      });

      // Re-read from disk
      const loaded = getCredentialMetadata("fal-ai", "api_key");
      expect(loaded).toBeDefined();
      expect(loaded!.alias).toBe("fal-primary");
      expect(loaded!.injectionTemplates).toEqual([falInjection]);
      expect(loaded!.allowedTools).toEqual(["api_request"]);
    });
  });

  // ── v5 Schema: OAuth fields removed ─────────────────────────────────

  describe("v5 schema — OAuth fields removed from CredentialMetadata", () => {
    test("CredentialMetadata does not include hasRefreshToken", () => {
      const record = upsertCredentialMetadata("github", "access_token", {
        allowedTools: ["api_request"],
      });
      // hasRefreshToken was removed in v5 — field should not exist
      expect("hasRefreshToken" in record).toBe(false);
    });

    test("CredentialMetadata does not include oauth2TokenUrl", () => {
      const record = upsertCredentialMetadata("github", "access_token");
      expect("oauth2TokenUrl" in record).toBe(false);
    });

    test("CredentialMetadata does not include oauth2ClientId", () => {
      const record = upsertCredentialMetadata("github", "access_token");
      expect("oauth2ClientId" in record).toBe(false);
    });

    test("CredentialMetadata does not include expiresAt", () => {
      const record = upsertCredentialMetadata("github", "access_token");
      expect("expiresAt" in record).toBe(false);
    });

    test("CredentialMetadata does not include grantedScopes", () => {
      const record = upsertCredentialMetadata("github", "access_token");
      expect("grantedScopes" in record).toBe(false);
    });
  });

  // ── Empty credential lists ────────────────────────────────────────

  describe("empty credential lists", () => {
    test("assertMetadataWritable succeeds for empty store", () => {
      expect(() => assertMetadataWritable()).not.toThrow();
    });

    test("delete on empty store returns false", () => {
      expect(deleteCredentialMetadata("nonexistent", "field")).toBe(false);
    });

    test("getCredentialMetadata on empty store returns undefined", () => {
      expect(getCredentialMetadata("nonexistent", "field")).toBeUndefined();
    });

    test("getCredentialMetadataById on empty store returns undefined", () => {
      expect(getCredentialMetadataById("nonexistent-id")).toBeUndefined();
    });
  });
});
