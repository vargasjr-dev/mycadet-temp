import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

// ---------------------------------------------------------------------------
// Mocks — declared before imports that depend on platform/logger
// ---------------------------------------------------------------------------

const WORKSPACE_DIR = process.env.CADET_WORKSPACE_DIR!;
const CONFIG_PATH = join(WORKSPACE_DIR, "config.json");

function ensureTestDir(): void {
  const dirs = [
    WORKSPACE_DIR,
    join(WORKSPACE_DIR, "data"),
    join(WORKSPACE_DIR, "data", "memory"),
    join(WORKSPACE_DIR, "data", "memory", "knowledge"),
    join(WORKSPACE_DIR, "data", "logs"),
  ];
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}

// Restore all mocked modules after this file's tests complete to prevent
// cross-test contamination when running grouped with other test files.
afterAll(() => {
  mock.restore();
});

import {
  CODE_DEFAULT_PROFILE_ENTRIES,
  getEffectiveProfile,
  getEffectiveProfiles,
  getEffectiveProfilesForProvider,
} from "../config/default-profile-catalog.js";
import {
  deepMergeOverwrite,
  getConfig,
  invalidateConfigCache,
} from "../config/loader.js";
import { LLMSchema } from "../config/schemas/llm.js";
import { seedInferenceProfiles } from "../config/seed-inference-profiles.js";
import type { DrizzleDb } from "../persistence/db-connection.js";
import { migrateCreateProviderConnections } from "../persistence/migrations/243-provider-connections.js";
import { migrateProviderConnectionStatusLabel } from "../persistence/migrations/244-provider-connection-status-label.js";
import { migrateProviderConnectionBaseUrlAndModels } from "../persistence/migrations/250-provider-connection-base-url-and-models.js";
import * as schema from "../persistence/schema/index.js";
import { getConnection } from "../providers/inference/connections.js";
import { getProviderDefaultModel } from "../providers/model-intents.js";
import { getConfigQuarantineNoticePath } from "../util/layout.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeConfig(obj: unknown): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(obj, null, 2) + "\n");
}

function seedProfilesAtBoot(db?: DrizzleDb): void {
  seedInferenceProfiles({ db });
}

/**
 * Mirror the config overlay's replacement flow: the hatch CLI config-sets
 * `llm.default.model` (when provided) and then `llm.default.provider`
 * through the assistant's config API, and the config-write route re-runs
 * the profile seeder in hatch mode on that first provider write (see
 * handleSetConfigByKey). The helper performs the same write-then-seed
 * sequence against the workspace config on disk.
 */
function applyHatchProviderSelection(options: {
  provider: string;
  model?: string;
  activeProfile?: string;
  profiles?: Record<string, unknown>;
  db?: DrizzleDb;
}): void {
  const raw = existsSync(CONFIG_PATH)
    ? (JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as Record<
        string,
        unknown
      >)
    : {};
  const llm: Record<string, unknown> = {
    ...((raw.llm as Record<string, unknown>) ?? {}),
  };
  const hadDefaultProviderBefore =
    (llm.default as Record<string, unknown> | undefined)?.provider != null;
  if (options.profiles !== undefined) {
    llm.profiles = options.profiles;
  }
  if (options.activeProfile !== undefined) {
    llm.activeProfile = options.activeProfile;
  }
  llm.default = {
    ...((llm.default as Record<string, unknown>) ?? {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
    provider: options.provider,
  };
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify({ ...raw, llm }, null, 2) + "\n",
  );
  invalidateConfigCache();
  if (!hadDefaultProviderBefore) {
    seedInferenceProfiles({ isHatch: true, db: options.db });
  }
}

/**
 * Profile names that must stay absent from `llm.profiles` after a BYOK
 * hatch: the default keys (no disabled stubs) and their `custom-*`
 * counterparts (no materialized copies).
 */
const LEGACY_HATCH_PROFILE_NAMES = [
  "balanced",
  "quality-optimized",
  "cost-optimized",
  "custom-balanced",
  "custom-quality-optimized",
  "custom-cost-optimized",
] as const;

/**
 * The cloud Balanced model. These tests assert that resolution serves the
 * code catalog rather than a workspace body, so they follow the catalog
 * instead of restating its pin.
 */
const MANAGED_BALANCED_MODEL = CODE_DEFAULT_PROFILE_ENTRIES.balanced
  .model as string;

function createProviderConnectionsDb(): DrizzleDb {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  const db = drizzle(sqlite, { schema });
  migrateCreateProviderConnections(db);
  migrateProviderConnectionStatusLabel(db);
  migrateProviderConnectionBaseUrlAndModels(db);
  return db;
}

// ---------------------------------------------------------------------------
// Tests: deepMergeOverwrite (unit) — JSON-null-as-deletion semantics
//
// `deepMergeOverwrite` backs the config PATCH route and platform
// override paths.
// ---------------------------------------------------------------------------

describe("deepMergeOverwrite", () => {
  test("overwrites top-level scalars", () => {
    const target: Record<string, unknown> = { a: 1, b: "old" };
    deepMergeOverwrite(target, { a: 2, c: "new" });
    expect(target).toEqual({ a: 2, b: "old", c: "new" });
  });

  test("recursively merges nested objects, overwriting leaves", () => {
    const target: Record<string, unknown> = {
      nested: { keep: "yes", change: "before" },
    };
    deepMergeOverwrite(target, {
      nested: { change: "after", added: 42 },
    });
    expect(target).toEqual({
      nested: { keep: "yes", change: "after", added: 42 },
    });
  });

  test("replaces arrays wholesale rather than merging", () => {
    const target: Record<string, unknown> = { items: [1, 2, 3] };
    deepMergeOverwrite(target, { items: [9] });
    expect(target).toEqual({ items: [9] });
  });

  test("assigns null to scalar fields (preserves nullable config values)", () => {
    const target: Record<string, unknown> = { a: 1, b: 2 };
    deepMergeOverwrite(target, { a: null });
    expect(target).toEqual({ a: null, b: 2 });
    expect("a" in target).toBe(true);
  });

  test("assigns null to nested scalar fields, preserving siblings", () => {
    const target: Record<string, unknown> = {
      a: { b: 1, c: 2, d: 3 },
    };
    deepMergeOverwrite(target, { a: { b: null } });
    expect(target).toEqual({ a: { b: null, c: 2, d: 3 } });
    expect("b" in (target.a as Record<string, unknown>)).toBe(true);
  });

  test("assigns null to existing null fields (no-op for already-null)", () => {
    const target: Record<string, unknown> = {
      heartbeat: { activeHoursStart: null, intervalMs: 6000 },
    };
    deepMergeOverwrite(target, {
      heartbeat: { activeHoursStart: null },
    });
    expect(target).toEqual({
      heartbeat: { activeHoursStart: null, intervalMs: 6000 },
    });
  });

  test("deletion of a nested key whose value is itself an object", () => {
    // Models the macOS clear-call-site-override case:
    // PATCH { llm: { callSites: { commitMessage: null } } } removes the
    // commitMessage entry entirely while keeping other call-site entries
    // and unrelated llm fields intact.
    const target: Record<string, unknown> = {
      llm: {
        provider: "anthropic",
        callSites: {
          commitMessage: { provider: "openai", model: "gpt-4" },
          memoryRetrieval: { profile: "fast" },
        },
      },
    };
    deepMergeOverwrite(target, {
      llm: { callSites: { commitMessage: null } },
    });
    expect(target).toEqual({
      llm: {
        provider: "anthropic",
        callSites: {
          memoryRetrieval: { profile: "fast" },
        },
      },
    });
  });

  test("deletion is a no-op when the key is already absent", () => {
    const target: Record<string, unknown> = { a: 1 };
    deepMergeOverwrite(target, { missing: null });
    expect(target).toEqual({ a: 1 });
    expect("missing" in target).toBe(false);
  });

  test("strips null leaves when assigning a whole subtree to a missing key", () => {
    // Models a PATCH that introduces a new call-site entry while clearing
    // some of its sub-fields in the same payload — the nulls must not
    // be persisted.
    const target: Record<string, unknown> = { llm: { provider: "anthropic" } };
    deepMergeOverwrite(target, {
      llm: {
        callSites: {
          commitMessage: { provider: null, model: "gpt-4", profile: null },
        },
      },
    });
    expect(target).toEqual({
      llm: {
        provider: "anthropic",
        callSites: {
          commitMessage: { model: "gpt-4" },
        },
      },
    });
  });

  test("strips null leaves when overwriting a scalar with an object subtree", () => {
    const target: Record<string, unknown> = { a: 1 };
    deepMergeOverwrite(target, { a: { b: null, c: 5, d: { e: null, f: 6 } } });
    expect(target).toEqual({ a: { c: 5, d: { f: 6 } } });
  });

  test("nullable config fields: null replaces scalar default, not deleted", () => {
    // Models PATCH { heartbeat: { activeHoursStart: null, activeHoursEnd: null } }
    // on a config where the defaults (8, 22) are in place. The nullable fields
    // must store null (meaning "disabled") — NOT be deleted (which would
    // re-apply schema defaults on next load).
    const target: Record<string, unknown> = {
      heartbeat: { intervalMs: 6000, activeHoursStart: 8, activeHoursEnd: 22 },
    };
    deepMergeOverwrite(target, {
      heartbeat: { activeHoursStart: null, activeHoursEnd: null },
    });
    expect(target).toEqual({
      heartbeat: {
        intervalMs: 6000,
        activeHoursStart: null,
        activeHoursEnd: null,
      },
    });
  });

  test("mixed: deletes object entries, assigns null to scalars in same merge", () => {
    // Verifies both behaviors coexist in a single merge: object entries are
    // deleted (call-site clearing) while scalar nulls are assigned (nullable fields).
    const target: Record<string, unknown> = {
      llm: {
        callSites: {
          commitMessage: { provider: "openai" },
        },
      },
      heartbeat: { activeHoursStart: 8 },
    };
    deepMergeOverwrite(target, {
      llm: { callSites: { commitMessage: null } },
      heartbeat: { activeHoursStart: null },
    });
    expect(target).toEqual({
      llm: { callSites: {} },
      heartbeat: { activeHoursStart: null },
    });
  });

  test("preserves explicit boolean false and zero (not treated as null)", () => {
    const target: Record<string, unknown> = { a: true, b: 1 };
    deepMergeOverwrite(target, { a: false, b: 0 });
    expect(target).toEqual({ a: false, b: 0 });
  });

  test("undefined override values are passed through, not treated as deletion", () => {
    // JSON.parse never produces undefined, but guard the in-process call path:
    // an explicit undefined assignment should follow the same "scalar overwrite"
    // path as before, not the null-deletion path.
    const target: Record<string, unknown> = { a: 1 };
    deepMergeOverwrite(target, { a: undefined });
    expect("a" in target).toBe(true);
    expect(target.a).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: getConfig() startup behavior
//
// Contract: disk = user intent, in-memory cache = effective values. getConfig
// must NOT silently materialize schema defaults into config.json on load.
// The legitimate self-healing paths that DO rewrite the file (deprecated-key
// strip, fresh-config seed, corrupt-JSON quarantine) are protected below.
// ---------------------------------------------------------------------------

describe("getConfig startup behavior", () => {
  beforeEach(() => {
    ensureTestDir();
    const resetPaths = [
      CONFIG_PATH,
      join(WORKSPACE_DIR, "default-config.json"),
      join(WORKSPACE_DIR, "hatch-overlay.json"),
      join(WORKSPACE_DIR, "keys.enc"),
      join(WORKSPACE_DIR, "data"),
      join(WORKSPACE_DIR, "data", "memory"),
    ];
    for (const path of resetPaths) {
      if (existsSync(path)) {
        rmSync(path, { recursive: true, force: true });
      }
    }
    // Also clear any leftover quarantine files from previous test runs.
    if (existsSync(WORKSPACE_DIR)) {
      for (const entry of readdirSync(WORKSPACE_DIR)) {
        if (entry.startsWith("config.json.corrupt-")) {
          rmSync(join(WORKSPACE_DIR, entry), { force: true });
        }
      }
    }
    // Clear any leftover config-quarantine notice sentinel from prior runs.
    const noticePath = getConfigQuarantineNoticePath();
    if (existsSync(noticePath)) {
      rmSync(noticePath, { force: true });
    }
    ensureTestDir();
    delete process.env.IS_CLOUD;
    invalidateConfigCache();
  });

  afterEach(() => {
    delete process.env.IS_CLOUD;
    invalidateConfigCache();
  });

  test("does not modify existing config.json on load", () => {
    // Write a partial config and confirm the file's bytes are unchanged
    // after getConfig(). Schema defaults must apply in-memory only; disk
    // is the user's source of truth.
    writeConfig({ provider: "anthropic" });
    const before = readFileSync(CONFIG_PATH);

    getConfig();

    const after = readFileSync(CONFIG_PATH);
    expect(after.equals(before)).toBe(true);
  });

  test("reloads cached config when config.json is updated externally", () => {
    // Models a CLI subprocess writing twilio.accountSid while the assistant
    // process already has an effective config cached in memory.
    writeConfig({ twilio: { accountSid: "AC_cached_before" } });
    expect(getConfig().twilio.accountSid).toBe("AC_cached_before");

    writeConfig({
      twilio: { accountSid: "AC_fresh_after_external_write" },
    });

    expect(getConfig().twilio.accountSid).toBe("AC_fresh_after_external_write");
  });

  test("still strips deprecated fields and rewrites", () => {
    // `warnAndStripDeprecatedFields` is a legitimate self-healing path:
    // it removes fields the schema no longer recognizes and persists the
    // cleaned config so the deprecation warning fires only once.
    writeConfig({
      provider: "anthropic",
      rateLimit: { maxTokensPerSession: 100_000 },
    });

    getConfig();

    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    expect(raw.rateLimit?.maxTokensPerSession).toBeUndefined();
    // Other rateLimit keys are not affected — only the deprecated entry is stripped
    expect(raw.provider).toBe("anthropic");
  });

  test("strips memory.jobs.batchSize from existing user configs", () => {
    // Pre-PR-#29364, the memory job worker read `memory.jobs.batchSize` to
    // size its single claim batch. The per-lane scheduler no longer reads
    // it, so the field is deprecated. Existing configs that have it
    // written to disk should load cleanly with the field silently stripped.
    writeConfig({
      provider: "anthropic",
      memory: { jobs: { batchSize: 25, workerConcurrency: 4 } },
    });

    getConfig();

    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    expect(raw.memory?.jobs?.batchSize).toBeUndefined();
    // Sibling fields under memory.jobs are preserved
    expect(raw.memory?.jobs?.workerConcurrency).toBe(4);
  });

  test("strips daemon.reapOrphanedSubprocesses from existing user configs", () => {
    // `daemon.reapOrphanedSubprocesses` is a deprecated opt-in flag: the
    // orphan-subprocess reaper runs by default whenever the daemon is PID 1 on
    // Linux. Existing configs that have it written to disk should load cleanly
    // with the field silently stripped.
    writeConfig({
      provider: "anthropic",
      daemon: { reapOrphanedSubprocesses: true, standaloneRecording: false },
    });

    getConfig();

    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    expect(raw.daemon?.reapOrphanedSubprocesses).toBeUndefined();
    // Sibling fields under daemon are preserved
    expect(raw.daemon?.standaloneRecording).toBe(false);
  });

  test("strips calls.voice.language from existing user configs", () => {
    // `calls.voice.language` is a retired no-op knob: nothing read it.
    // The spoken language lives at `services.stt.language` and per-language
    // TTS voices at `services.tts.providers.<id>.languageVoices`. Existing
    // configs that have it written to disk should load cleanly with the
    // field stripped and its siblings preserved.
    writeConfig({
      provider: "anthropic",
      calls: { voice: { language: "es-ES", telephonyStreaming: false } },
    });

    getConfig();

    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    expect(raw.calls?.voice?.language).toBeUndefined();
    // Sibling fields under calls.voice are preserved
    expect(raw.calls?.voice?.telephonyStreaming).toBe(false);
  });

  test("boot repairs a non-dispatchable active profile", () => {
    writeConfig({
      llm: {
        default: { provider: "anthropic", model: "claude-opus-4-7" },
        profiles: {
          placeholder: { label: "Placeholder" },
        },
        profileOrder: ["placeholder"],
        activeProfile: "placeholder",
      },
    });

    seedProfilesAtBoot();
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    expect(raw.llm.profiles.placeholder).toBeUndefined();
    expect(raw.llm.profileOrder).not.toContain("placeholder");
    expect(raw.llm.activeProfile).toBe("balanced");
  });

  test("boot removes non-dispatchable profile references", () => {
    writeConfig({
      llm: {
        default: { provider: "anthropic", model: "claude-opus-4-7" },
        profiles: {
          placeholder: { label: "Placeholder" },
          pinned: {
            provider: "anthropic",
            model: "claude-opus-4-7",
          },
          blend: {
            mix: [
              { profile: "placeholder", weight: 1 },
              { profile: "pinned", weight: 1 },
            ],
          },
        },
        profileOrder: ["placeholder", "blend", "pinned"],
        activeProfile: "blend",
        advisorProfile: "placeholder",
        callSites: {
          commitMessage: {
            profile: "placeholder",
            maxTokens: 256,
          },
        },
      },
    });

    seedProfilesAtBoot();
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    expect(raw.llm.profiles.placeholder).toBeUndefined();
    expect(raw.llm.profiles.blend).toBeUndefined();
    expect(raw.llm.profiles.pinned.provider).toBe("anthropic");
    expect(raw.llm.profileOrder).not.toContain("placeholder");
    expect(raw.llm.profileOrder).not.toContain("blend");
    expect(raw.llm.activeProfile).toBe("balanced");
    expect(raw.llm.advisorProfile).toBe("quality-optimized");
    expect(raw.llm.callSites.commitMessage.profile).toBeUndefined();
    expect(raw.llm.callSites.commitMessage.maxTokens).toBe(256);
  });

  test("off-cloud hatch with openai resolves the defaults through the openai column", () => {
    applyHatchProviderSelection({ provider: "openai" });
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    expect(raw.llm.activeProfile).toBe("balanced");
    expect(raw.llm.default).toEqual({ provider: "openai" });
    for (const name of LEGACY_HATCH_PROFILE_NAMES) {
      expect(raw.llm.profiles[name]).toBeUndefined();
    }

    // The defaults resolve active through the openai column of the matrix,
    // stamped with the personal connection.
    const effective = getEffectiveProfilesForProvider(LLMSchema.parse(raw.llm));
    expect(effective.balanced?.provider).toBe("openai");
    expect(effective.balanced?.model).toBe("gpt-5.6-luna");
    expect(effective.balanced?.provider_connection).toBe("openai-personal");
    expect(effective["quality-optimized"]?.provider).toBe("openai");
    expect(effective["quality-optimized"]?.model).toBe("gpt-5.6-sol");
    expect(effective["cost-optimized"]?.provider).toBe("openai");
    expect(effective["cost-optimized"]?.model).toBe("gpt-5.6-luna");
  });

  test("off-cloud hatch with a provider outside the named matrix columns resolves through the shared BYOK templates", () => {
    // `together` has no column in PROFILE_IMPLS and no intent table: the
    // defaults must still anchor on it (not fall back to anthropic), backed
    // by the `together-personal` connection and its catalog defaultModel.
    const db = createProviderConnectionsDb();

    applyHatchProviderSelection({ provider: "together", db });
    const config = getConfig();
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    expect(raw.llm.activeProfile).toBe("balanced");
    expect(raw.llm.default).toEqual({ provider: "together" });
    // The parsed schema keeps the blob — the partial-fragment field must not
    // drop it.
    expect(config.llm.default).toEqual({ provider: "together" });
    for (const name of LEGACY_HATCH_PROFILE_NAMES) {
      expect(raw.llm.profiles[name]).toBeUndefined();
    }
    expect(getConnection(db, "together-personal")).not.toBeNull();

    const effective = getEffectiveProfilesForProvider(LLMSchema.parse(raw.llm));
    for (const name of [
      "balanced",
      "quality-optimized",
      "cost-optimized",
    ] as const) {
      expect(effective[name]?.provider).toBe("together");
      expect(effective[name]?.provider_connection).toBe("together-personal");
      expect(effective[name]?.model).toBe(getProviderDefaultModel("together"));
    }
  });

  test("off-cloud hatch with a connection-eligible provider that is not a default-provider choice falls back to anthropic", () => {
    // `typesafe` passes the connection gate (API-key catalog provider, and
    // not in PROVIDERS_REQUIRING_BASE_URL_AND_MODELS) but it is not a known
    // LLM provider, so no profile can reference it and it is not a
    // DEFAULT_PROVIDER_CHOICES member. The key and `typesafe-personal`
    // connection are still stored for manually-created profiles, but the
    // defaults anchor on anthropic: the seeder re-anchors the freshly
    // written provider on its way through.
    const db = createProviderConnectionsDb();

    applyHatchProviderSelection({ provider: "typesafe", db });
    const config = getConfig();
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    expect(raw.llm.activeProfile).toBe("balanced");
    expect(raw.llm.default).toEqual({ provider: "anthropic" });
    expect(config.llm.default).toEqual({ provider: "anthropic" });
    for (const name of LEGACY_HATCH_PROFILE_NAMES) {
      expect(raw.llm.profiles[name]).toBeUndefined();
    }
    expect(getConnection(db, "typesafe-personal")).not.toBeNull();

    const effective = getEffectiveProfilesForProvider(LLMSchema.parse(raw.llm));
    for (const name of [
      "balanced",
      "quality-optimized",
      "cost-optimized",
    ] as const) {
      expect(effective[name]?.provider).toBe("anthropic");
      expect(effective[name]?.provider_connection).toBe("anthropic-personal");
    }
  });

  test("off-cloud boot leaves an existing managed entry byte-identical", () => {
    // A drifted full-body entry left by a previous release stays exactly
    // as written — boots never rewrite managed entries. Content is served
    // from the code catalog at resolution time instead.
    const drifted = {
      provider: "cadet",
      model: "claude-sonnet-4-6",
    };
    writeConfig({
      llm: {
        profiles: { balanced: drifted },
        activeProfile: "balanced",
      },
    });

    // Non-hatch boot (no overlay).
    seedProfilesAtBoot();
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    expect(raw.llm.profiles.balanced).toEqual(drifted);
    expect(raw.llm.activeProfile).toBe("balanced");
    // Resolution ignores the drifted body: a cadet-provider entry
    // contributes only label/status/topP, everything else comes from the
    // catalog.
    const effectiveBalanced = getEffectiveProfile(raw.llm.profiles, "balanced");
    expect(effectiveBalanced?.model).toBe(MANAGED_BALANCED_MODEL);
    expect(effectiveBalanced?.provider_connection).toBeUndefined();
  });

  test("defaults the advisor profile to the cloud Quality profile", () => {
    writeConfig({ llm: { default: { provider: "anthropic" } } });

    seedProfilesAtBoot();
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    // The strongest active managed default via the effective view. No
    // workspace entry backs it — the content is code-owned.
    expect(raw.llm.advisorProfile).toBe("quality-optimized");
    expect(raw.llm.profiles["quality-optimized"]).toBeUndefined();
    const effectiveQuality = getEffectiveProfile(
      raw.llm.profiles,
      "quality-optimized",
    );
    expect(effectiveQuality?.model).toBe("gpt-5.6-sol");
  });

  test("platform boot leaves a drifted managed entry byte-identical; resolution serves catalog content", () => {
    // Headline behavior: default profile content is code-owned, so model/config
    // updates ship in a release without any workspace rewrite. Boots never
    // touch managed entries; the effective view serves the catalog body and
    // overlays only label/status/topP from the workspace entry.
    process.env.IS_CLOUD = "true";

    const drifted = {
      provider: "cadet",
      model: "gpt-5.4",
      maxTokens: 1,
    };
    writeConfig({
      llm: {
        profiles: { balanced: drifted },
        activeProfile: "balanced",
      },
    });

    // Non-hatch boot (no overlay).
    seedProfilesAtBoot();
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    expect(raw.llm.profiles.balanced).toEqual(drifted);
    expect(raw.llm.activeProfile).toBe("balanced");
    const effectiveBalanced = getEffectiveProfile(raw.llm.profiles, "balanced");
    expect(effectiveBalanced?.model).toBe(MANAGED_BALANCED_MODEL);
    expect(effectiveBalanced?.maxTokens).toBe(32000);
    expect(effectiveBalanced?.provider_connection).toBeUndefined();
    // The catalog body carries no topP and the entry has none, so the
    // effective profile has no topP override.
    expect("topP" in (effectiveBalanced ?? {})).toBe(false);
  });

  test("platform boot preserves user-edited label and status on a managed stub", () => {
    // The workspace-owned fields a user may set on a cloud profile — label
    // and status — live on the stub, which boots never touch. The effective
    // view overlays them onto the code-owned body.
    process.env.IS_CLOUD = "true";

    const edited = {
      provider: "cadet",
      label: "My Default",
      status: "disabled",
    };
    writeConfig({
      llm: {
        profiles: { balanced: edited },
        activeProfile: "balanced",
      },
    });

    seedProfilesAtBoot();
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    expect(raw.llm.profiles.balanced).toEqual(edited);
    const effectiveBalanced = getEffectiveProfile(raw.llm.profiles, "balanced");
    // Content is served from the catalog...
    expect(effectiveBalanced?.model).toBe(MANAGED_BALANCED_MODEL);
    // ...with the user's label and status overlaid.
    expect(effectiveBalanced?.label).toBe("My Default");
    expect(effectiveBalanced?.status).toBe("disabled");
  });

  test("off-cloud boot preserves a user-edited label on a managed stub (Codex P1 on PR #30362)", () => {
    // Simulate a user who renamed the cloud "balanced" profile via
    // PUT /v1/config/llm/profiles/balanced { label: "My Default" }.
    const stub = { provider: "cadet", label: "My Default" };
    writeConfig({
      llm: {
        profiles: { balanced: stub },
        activeProfile: "balanced",
      },
    });

    seedProfilesAtBoot();
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    // The stub is untouched, and the user's label rides on top of the
    // catalog body in the effective view.
    expect(raw.llm.profiles.balanced).toEqual(stub);
    const effectiveBalanced = getEffectiveProfile(raw.llm.profiles, "balanced");
    expect(effectiveBalanced?.label).toBe("My Default");
    expect(effectiveBalanced?.model).toBe(MANAGED_BALANCED_MODEL);
  });

  test("off-cloud boot preserves user-toggled status on a managed stub", () => {
    // Simulate a user who disabled the cloud "balanced" profile via
    // PUT /v1/config/llm/profiles/balanced { status: "disabled" }.
    const stub = { provider: "cadet", status: "disabled" };
    writeConfig({
      llm: {
        profiles: { balanced: stub },
        activeProfile: "balanced",
      },
    });

    seedProfilesAtBoot();
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    expect(raw.llm.profiles.balanced).toEqual(stub);
    const effectiveBalanced = getEffectiveProfile(raw.llm.profiles, "balanced");
    expect(effectiveBalanced?.status).toBe("disabled");
    // Content still comes from the catalog — only label/status/topP are
    // workspace-owned.
    expect(effectiveBalanced?.model).toBe(MANAGED_BALANCED_MODEL);
  });

  test("boot preserves a user-edited topP override on a managed stub", () => {
    // Simulate a user who overrode topP on the cloud "balanced" profile via
    // PUT /v1/config/llm/profiles/balanced { topP: 0.5 }. The override lives
    // on the stub, survives boots untouched, and overlays the catalog body
    // (which carries no topP of its own).
    const stub = { provider: "cadet", topP: 0.5 };
    writeConfig({
      llm: {
        profiles: { balanced: stub },
        activeProfile: "balanced",
      },
    });

    seedProfilesAtBoot();
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    expect(raw.llm.profiles.balanced).toEqual(stub);
    const effectiveBalanced = getEffectiveProfile(raw.llm.profiles, "balanced");
    expect(effectiveBalanced?.topP).toBe(0.5);
    // Content still comes from the catalog — topP is workspace-owned, the
    // rest is code-owned.
    expect(effectiveBalanced?.model).toBe(MANAGED_BALANCED_MODEL);
  });

  test("effective balanced profile carries no topP override by default", () => {
    // Boots write no managed entry, and the catalog body (matching the
    // quality profile) carries no topP — so the effective balanced profile
    // has none either.
    writeConfig({ llm: {} });

    seedProfilesAtBoot();
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    expect(raw.llm.profiles.balanced).toBeUndefined();
    const effectiveBalanced = getEffectiveProfile(raw.llm.profiles, "balanced");
    expect("topP" in (effectiveBalanced ?? {})).toBe(false);
  });

  test("off-cloud reseed preserves an explicit null label (user cleared it)", () => {
    // Setting label to null is the "clear" intent — must survive too,
    // otherwise the next boot would re-stamp the template's default
    // label and ignore the user's clear action.
    writeConfig({
      llm: {
        profiles: {
          balanced: {
            provider: "cadet",
            model: "old-model",
            label: null,
          },
        },
        activeProfile: "balanced",
      },
    });

    seedProfilesAtBoot();
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    expect(raw.llm.profiles.balanced.label).toBeNull();
  });

  test("non-hatch off-cloud boot writes no managed entries; defaults resolve bare-labeled from the catalog", () => {
    // First boot of a config with no prior profiles and no hatch overlay:
    // nothing is materialized for the default names. The " (Managed)" label
    // suffix exists only on the thin stubs written at BYOK hatch time; a
    // plain boot serves the bare catalog labels through the effective view.
    writeConfig({});

    seedProfilesAtBoot();
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    expect(raw.llm.profiles.balanced).toBeUndefined();
    const effectiveBalanced = getEffectiveProfile(raw.llm.profiles, "balanced");
    expect(effectiveBalanced?.label).toBe("Balanced");
    expect(effectiveBalanced?.model).toBe(MANAGED_BALANCED_MODEL);
    // Status is unset — the default resolves active.
    expect("status" in (effectiveBalanced ?? {})).toBe(false);
  });

  test("an active managed backup profile survives a reload", () => {
    // A managed backup resolves from the code catalog without being
    // materialized in `llm.profiles`, so selecting one persists nothing but
    // the reference. If the schema did not treat backup keys as
    // always-available references, the strip-and-reparse in `getConfig`
    // would drop `activeProfile` and the seeder would reset the user's
    // chat-model selection to `balanced` on the next boot.
    writeConfig({
      llm: {
        default: {
          provider: "cadet",
        },
        profiles: {},
        activeProfile: "balanced-backup",
      },
    });

    const config = getConfig();
    expect(config.llm.activeProfile).toBe("balanced-backup");

    seedProfilesAtBoot();

    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    expect(raw.llm.activeProfile).toBe("balanced-backup");
    expect(raw.llm.profiles["balanced-backup"]).toBeUndefined();
  });

  test("an active managed backup profile is repaired on a BYOK install", () => {
    // Backups live on the cloud column alone, so under a BYOK default
    // provider the selection names a profile that resolves to nothing. The
    // schema rejects the reference on load and the seeder, which resolves
    // availability through the same provider-aware view, repairs the stored
    // selection instead of preserving a dead pointer.
    writeConfig({
      llm: {
        default: {
          provider: "anthropic",
        },
        profiles: {},
        activeProfile: "balanced-backup",
      },
    });

    const config = getConfig();
    expect(config.llm.activeProfile).toBeUndefined();

    seedProfilesAtBoot();

    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    expect(raw.llm.activeProfile).toBe("balanced");
  });

  test("a call site pinned to a cloud backup profile survives a reload", () => {
    writeConfig({
      llm: {
        default: {
          provider: "cadet",
        },
        profiles: {},
        activeProfile: "balanced",
        callSites: { recall: { profile: "cost-optimized-backup" } },
      },
    });

    const config = getConfig();
    expect(config.llm.callSites.recall?.profile).toBe("cost-optimized-backup");

    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    expect(raw.llm.callSites.recall.profile).toBe("cost-optimized-backup");
  });

  test("off-cloud BYOK hatch defaults advisor to quality-optimized", () => {
    applyHatchProviderSelection({ provider: "anthropic" });
    const config = getConfig();

    expect(config.llm.activeProfile).toBe("balanced");
    expect(config.llm.advisorProfile).toBe("quality-optimized");
  });

  test("off-cloud boot clears a disabled managed advisor even when a personal profile exists", () => {
    writeConfig({
      llm: {
        advisorProfile: "frontier",
        profiles: {
          frontier: {
            provider: "cadet",
            model: "claude-opus-4-8",
            status: "disabled",
          },
          balanced: {
            provider: "cadet",
            model: "open-model",
            status: "disabled",
          },
          "quality-optimized": {
            provider: "cadet",
            model: "accounts/fireworks/models/glm-5p2",
            status: "disabled",
          },
          "cost-optimized": {
            provider: "cadet",
            model: "accounts/fireworks/models/deepseek-v4-flash",
            status: "disabled",
          },
          "custom-quality-optimized": {
            provider: "cadet",
            provider_connection: "anthropic-personal",
            model: "claude-opus-4-8",
            label: "Quality",
          },
        },
      },
    });

    seedProfilesAtBoot();
    const config = getConfig();

    // Advisor repair only considers the cloud defaults; a user profile is
    // never auto-selected, so a fully-disabled managed set clears the field.
    expect(config.llm.advisorProfile).toBeUndefined();
  });

  test("platform boot repairs a disabled managed advisor to an active cloud profile", () => {
    process.env.IS_CLOUD = "true";
    writeConfig({
      llm: {
        advisorProfile: "frontier",
        profiles: {
          frontier: {
            provider: "cadet",
            model: "claude-opus-4-8",
            status: "disabled",
          },
          "custom-quality-optimized": {
            provider: "cadet",
            provider_connection: "anthropic-personal",
            model: "claude-opus-4-8",
            label: "Quality",
          },
        },
      },
    });

    seedProfilesAtBoot();
    const config = getConfig();

    expect(config.llm.advisorProfile).toBe("quality-optimized");
  });

  test("off-cloud managed-inference hatch respects explicit non-managed active connection", () => {
    const db = createProviderConnectionsDb();

    applyHatchProviderSelection({
      provider: "anthropic",
      activeProfile: "balanced",
      profiles: {
        balanced: {
          provider: "cadet",
          provider_connection: "anthropic-personal",
          model: "claude-sonnet-4-6",
        },
      },
      db,
    });
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    expect(raw.llm.activeProfile).toBe("balanced");
    expect(raw.llm.profiles.balanced.provider_connection).toBe(
      "anthropic-personal",
    );
    // Connections exist (status is no longer a connection-level concept).
    expect(getConnection(db, "anthropic-managed")).not.toBeNull();
    expect(getConnection(db, "openai-managed")).not.toBeNull();
    expect(getConnection(db, "gemini-managed")).not.toBeNull();
  });

  test("on-cloud hatch writes no managed stubs; catalog labels stay bare", () => {
    process.env.IS_CLOUD = "true";

    applyHatchProviderSelection({ provider: "anthropic" });
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    // Platform hatches materialize nothing, and the catalog labels carry no
    // "(Managed)" suffix — the personal profiles don't exist here so there's
    // nothing to disambiguate from.
    expect(raw.llm.profiles).toEqual({});
    const effective = getEffectiveProfiles(raw.llm.profiles);
    expect(effective.balanced?.label).toBe("Balanced");
    expect(effective["quality-optimized"]?.label).toBe("Quality");
    expect(effective["cost-optimized"]?.label).toBe("Budget");
  });

  test("a cloud key missing from profileOrder lands beside its siblings", () => {
    // An install that predates a newly shipped cloud profile, with a custom
    // profile already in its order. The new key belongs with the other
    // cloud profiles, not after whatever the user has arranged below them.
    writeConfig({
      llm: {
        default: { provider: "anthropic", model: "claude-opus-4-7" },
        profiles: {
          "my-custom": { source: "user", provider: "anthropic", model: "x" },
        },
        profileOrder: [
          "balanced",
          "quality-optimized",
          "cost-optimized",
          "my-custom",
        ],
        activeProfile: "balanced",
      },
    });

    seedProfilesAtBoot();
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    expect(raw.llm.profileOrder).toEqual([
      "balanced",
      "quality-optimized",
      "cost-optimized",
      "latency-optimized",
      "balanced-backup",
      "quality-optimized-backup",
      "cost-optimized-backup",
      "latency-optimized-backup",
      "jev-managed",
      "my-custom",
    ]);
  });

  test("boot leaves legacy bare labels on managed entries untouched", () => {
    // Existing off-cloud install has bare labels (`label: "Balanced"`)
    // on its managed entries. Boots never rewrite managed entries — there
    // is no label-suffix upgrade pass — so the entries stay byte-identical
    // and the bare labels flow through the effective view.
    const legacyProfiles = {
      balanced: {
        provider: "cadet",
        model: "claude-sonnet-4-6",
        label: "Balanced",
      },
      "quality-optimized": {
        provider: "cadet",
        label: "Quality",
      },
      "cost-optimized": {
        provider: "cadet",
        label: "Speed",
      },
    };
    writeConfig({
      llm: {
        default: { provider: "anthropic", model: "claude-opus-4-7" },
        profiles: legacyProfiles,
        activeProfile: "balanced",
      },
    });

    // No overlay → not a hatch.
    seedProfilesAtBoot();
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    expect(raw.llm.profiles).toEqual(legacyProfiles);
    const effective = getEffectiveProfiles(raw.llm.profiles);
    expect(effective.balanced?.label).toBe("Balanced");
    expect(effective["quality-optimized"]?.label).toBe("Quality");
    expect(effective["cost-optimized"]?.label).toBe("Speed");
  });

  test("boot preserves user-customized labels and explicit null on off-cloud", () => {
    // A user-set string that differs from the bare default survives, as
    // does an explicit null (user cleared the label) — boots never touch
    // managed entries, whatever label state they carry.
    writeConfig({
      llm: {
        default: { provider: "anthropic", model: "claude-opus-4-7" },
        profiles: {
          balanced: {
            provider: "cadet",
            model: "claude-sonnet-4-6",
            label: "My Balanced",
          },
          "quality-optimized": {
            provider: "cadet",
            label: null,
          },
          // Already-suffixed labels are also preserved (idempotency).
          "cost-optimized": {
            provider: "cadet",
            label: "Speed (Managed)",
          },
        },
        activeProfile: "balanced",
      },
    });

    seedProfilesAtBoot();
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    expect(raw.llm.profiles.balanced.label).toBe("My Balanced");
    expect(raw.llm.profiles["quality-optimized"].label).toBeNull();
    expect(raw.llm.profiles["cost-optimized"].label).toBe("Speed (Managed)");
  });

  test("platform boot leaves a bare label on a cloud entry untouched", () => {
    // An on-cloud install with a bare "Balanced" label keeps it — boots
    // never rewrite managed entries, and no suffix exists on platform.
    process.env.IS_CLOUD = "true";
    writeConfig({
      llm: {
        default: { provider: "anthropic", model: "claude-opus-4-7" },
        profiles: {
          balanced: {
            provider: "cadet",
            model: "claude-sonnet-4-6",
            label: "Balanced",
          },
        },
        activeProfile: "balanced",
      },
    });

    seedProfilesAtBoot();
    const config = getConfig();

    expect(config.llm.profiles.balanced?.label).toBe("Balanced");
  });

  test("subsequent off-cloud boot preserves user-set status on cloud profiles", () => {
    // Simulate a user who hatched yesterday, then re-enabled the cloud
    // Balanced profile (they have platform auth via a separate route).
    writeConfig({
      llm: {
        default: { provider: "anthropic", model: "claude-opus-4-7" },
        profiles: {
          balanced: {
            provider: "cadet",
            model: "claude-sonnet-4-6",
            label: "Balanced (Managed)",
            status: "active",
          },
          "custom-balanced": {
            provider: "cadet",
            provider_connection: "anthropic-personal",
            model: "claude-sonnet-4-6",
            label: "Balanced",
          },
        },
        activeProfile: "balanced",
      },
    });

    // No overlay → this is a normal boot, not a hatch.
    seedProfilesAtBoot();
    const config = getConfig();

    // User's "active" decision survives the boot upsert.
    expect(config.llm.profiles.balanced?.status).toBe("active");
    // Label is still suffixed (Cadet can push label updates).
    expect(config.llm.profiles.balanced?.label).toBe("Balanced (Managed)");
  });
});
