/**
 * Unit tests for the credential metadata merge helper used by the bundle
 * importers. Covers the behaviour the two importers rely on:
 *
 * - Bundle without cadet + target with cadet → target's cadet entries
 *   survive and the bundle's non-cadet entries are kept.
 * - Bundle with mixed user services → non-cadet entries import, any
 *   rogue cadet entries in the bundle are dropped.
 * - Live metadata empty / missing → bundle lands as-is.
 * - Malformed inputs → no corruption (bundle returned verbatim).
 */

import { describe, expect, test } from "bun:test";

import { mergeMetadataPreservingCadet } from "../vbundle-metadata-merge.js";

interface Record {
  credentialId: string;
  service: string;
  field: string;
  allowedTools: string[];
  allowedDomains: string[];
  createdAt: number;
  updatedAt: number;
}

function record(
  overrides: Partial<Record> & Pick<Record, "service" | "field">,
): Record {
  const now = Date.now();
  return {
    credentialId: `id-${overrides.service}-${overrides.field}`,
    allowedTools: [],
    allowedDomains: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function file(records: Record[], version = 5): string {
  return JSON.stringify({ version, credentials: records });
}

function parse(json: string): { version?: number; credentials: Record[] } {
  const parsed = JSON.parse(json);
  return {
    version: parsed.version,
    credentials: (parsed.credentials ?? []) as Record[],
  };
}

function asKey(r: Record): string {
  return `${r.service}:${r.field}`;
}

function keys(records: Record[]): Set<string> {
  return new Set(records.map(asKey));
}

const CADET_FIELDS = [
  "webhook_secret",
  "assistant_api_key",
  "platform_assistant_id",
] as const;

function cadetRecords(): Record[] {
  return CADET_FIELDS.map((field) =>
    record({ service: "cadet", field, credentialId: `target-${field}` }),
  );
}

describe("mergeMetadataPreservingCadet", () => {
  test("preserves all four target cadet:* entries when bundle has none", () => {
    const target = cadetRecords();
    const bundle = [
      record({ service: "telegram", field: "bot_token" }),
      record({ service: "slack_channel", field: "app_token" }),
    ];

    const merged = parse(
      mergeMetadataPreservingCadet(file(bundle), file(target)),
    );

    const mergedKeys = keys(merged.credentials);
    for (const field of CADET_FIELDS) {
      expect(mergedKeys.has(`cadet:${field}`)).toBe(true);
    }
    expect(mergedKeys.has("telegram:bot_token")).toBe(true);
    expect(mergedKeys.has("slack_channel:app_token")).toBe(true);
  });

  test("bundle non-cadet entries still import alongside preserved cadet entries", () => {
    const target = cadetRecords();
    const bundle = [
      record({ service: "telegram", field: "bot_token" }),
      record({ service: "telegram", field: "webhook_secret" }),
      record({ service: "google", field: "access_token" }),
    ];

    const merged = parse(
      mergeMetadataPreservingCadet(file(bundle), file(target)),
    );

    // 3 cadet + 3 user = 6 total.
    expect(merged.credentials.length).toBe(6);
    expect(keys(merged.credentials).size).toBe(6);

    // Target's credentialIds for cadet are preserved (not the bundle's).
    for (const r of merged.credentials) {
      if (r.service === "cadet") {
        expect(r.credentialId.startsWith("target-")).toBe(true);
      }
    }
  });

  test("drops bundle cadet:* entries and preserves target's identity", () => {
    const target = cadetRecords();
    // Bundle carries conflicting cadet entries — should be dropped even
    // though the source would normally be filtered before this helper is
    // called.
    const bundle = [
      record({
        service: "cadet",
        field: "assistant_api_key",
        credentialId: "source-rogue",
      }),
      record({
        service: "cadet",
        field: "webhook_secret",
        credentialId: "source-rogue-url",
      }),
      record({ service: "telegram", field: "bot_token" }),
    ];

    const merged = parse(
      mergeMetadataPreservingCadet(file(bundle), file(target)),
    );

    const cadetRecordsOut = merged.credentials.filter(
      (r) => r.service === "cadet",
    );
    expect(cadetRecordsOut.length).toBe(3);
    for (const r of cadetRecordsOut) {
      expect(r.credentialId.startsWith("target-")).toBe(true);
    }
    // Telegram entry still imports.
    expect(
      merged.credentials.some(
        (r) => r.service === "telegram" && r.field === "bot_token",
      ),
    ).toBe(true);
  });

  test("no live metadata → bundle passes through unchanged (no cadet in bundle)", () => {
    const bundle = [
      record({ service: "telegram", field: "bot_token" }),
      record({ service: "slack_channel", field: "app_token" }),
    ];
    const merged = parse(mergeMetadataPreservingCadet(file(bundle), null));
    expect(keys(merged.credentials)).toEqual(
      new Set(["telegram:bot_token", "slack_channel:app_token"]),
    );
  });

  test("no live metadata still strips bundle cadet:* entries", () => {
    const bundle = [
      record({ service: "cadet", field: "assistant_api_key" }),
      record({ service: "telegram", field: "bot_token" }),
    ];
    const merged = parse(mergeMetadataPreservingCadet(file(bundle), null));
    // Bundle's cadet entry is always filtered.
    expect(merged.credentials.length).toBe(1);
    expect(merged.credentials[0]?.service).toBe("telegram");
  });

  test("preserves bundle version field verbatim", () => {
    const bundle = file([record({ service: "telegram", field: "bot_token" })]);
    const merged = JSON.parse(
      mergeMetadataPreservingCadet(bundle, file(cadetRecords())),
    );
    expect(merged.version).toBe(5);
  });

  test("malformed bundle JSON → returned unchanged (never corrupt the file)", () => {
    const bad = "{not valid json";
    const live = file(cadetRecords());
    const result = mergeMetadataPreservingCadet(bad, live);
    expect(result).toBe(bad);
  });

  test("malformed live JSON → bundle returned as merged output without preservation", () => {
    const bundle = file([record({ service: "telegram", field: "bot_token" })]);
    const merged = parse(mergeMetadataPreservingCadet(bundle, "{bad"));
    expect(keys(merged.credentials)).toEqual(new Set(["telegram:bot_token"]));
  });

  test("live metadata with extra non-cadet entries does NOT smuggle them in", () => {
    const live = file([
      ...cadetRecords(),
      record({ service: "telegram", field: "bot_token" }),
      record({ service: "notion", field: "api_key" }),
    ]);
    const bundle = file([
      record({ service: "slack_channel", field: "app_token" }),
    ]);

    const merged = parse(mergeMetadataPreservingCadet(bundle, live));

    // Only bundle's non-cadet + target's cadet. Target's user entries
    // must NOT carry over (they belong to source-style flows, handled by
    // the bundle).
    expect(keys(merged.credentials).has("slack_channel:app_token")).toBe(true);
    expect(keys(merged.credentials).has("telegram:bot_token")).toBe(false);
    expect(keys(merged.credentials).has("notion:api_key")).toBe(false);
    for (const field of CADET_FIELDS) {
      expect(keys(merged.credentials).has(`cadet:${field}`)).toBe(true);
    }
  });
});
