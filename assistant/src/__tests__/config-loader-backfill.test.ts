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
import { resolveCallSiteConfig } from "../config/llm-resolver.js";
import {
  deepMergeOverwrite,
  getConfig,
  invalidateConfigCache,
  mergeDefaultWorkspaceConfig,
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

function latencySeed(): Record<string, unknown> {
  return {
    model: "claude-haiku-4-5-20251001",
    effort: "low",
    thinking: { enabled: false },
  };
}

function fullSeededCallSites(): Record<string, Record<string, unknown>> {
  return {
    guardianQuestionCopy: latencySeed(),
    interactionClassifier: latencySeed(),
    skillCategoryInference: latencySeed(),
    inviteInstructionGenerator: latencySeed(),
    notificationDecision: latencySeed(),
    preferenceExtraction: latencySeed(),
    commitMessage: {
      model: "claude-haiku-4-5-20251001",
      maxTokens: 120,
      temperature: 0.2,
      effort: "low",
      thinking: { enabled: false },
    },
    conversationStarters: latencySeed(),
    conversationSummarization: {
      model: "claude-opus-4-7",
      effort: "low",
      thinking: { enabled: false },
    },
    recall: {
      profile: "cost-optimized",
      maxTokens: 4096,
      effort: "low",
      thinking: { enabled: false, streamThinking: false },
      temperature: 0,
      disableCache: true,
    },
    heartbeatAgent: {
      profile: "cost-optimized",
      maxTokens: 2048,
      effort: "low",
      temperature: 0,
      thinking: { enabled: false, streamThinking: false },
      contextWindow: { maxInputTokens: 16000 },
    },
    replySuggestion: {
      model: "claude-haiku-4-5-20251001",
      effort: "low",
      thinking: { enabled: false },
      disableCache: true,
    },
    memoryRouter: {
      profile: "cost-optimized",
      contextWindow: { maxInputTokens: 1_000_000 },
    },
  };
}

function mergeDefaultConfigAndSeedInferenceProfiles(db?: DrizzleDb): void {
  const defaultConfigMerge = mergeDefaultWorkspaceConfig();
  seedInferenceProfiles({
    preserveActiveProfile: defaultConfigMerge.providedLlmActiveProfile,
    isHatch: defaultConfigMerge.hadOverlay,
    db,
  });
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
// `deepMergeOverwrite` is used by `mergeDefaultWorkspaceConfig` and platform
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
    delete process.env.CADET_DEFAULT_WORKSPACE_CONFIG_PATH;
    delete process.env.IS_CLOUD;
    invalidateConfigCache();
  });

  afterEach(() => {
    delete process.env.CADET_DEFAULT_WORKSPACE_CONFIG_PATH;
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

  test("getConfig().memory.v2.bm25_b returns schema default when absent on disk", () => {
    // Consumer-side correctness: even though getConfig no longer writes
    // schema defaults back to disk, accessors still see them via the
    // in-memory `cached: AssistantConfig` populated by `applyNestedDefaults`.
    writeConfig({ provider: "anthropic" });

    const config = getConfig();

    expect(config.memory.v2.bm25_b).toBe(0.4);
  });

  test("default workspace config merge prunes exact seeded call-site defaults", () => {
    const seededCallSites = fullSeededCallSites();
    const overlayPath = join(WORKSPACE_DIR, "hatch-overlay.json");
    writeFileSync(
      overlayPath,
      JSON.stringify(
        {
          gateway: {
            unmappedPolicy: "default",
            defaultAssistantId: "self",
          },
          llm: {
            activeProfile: "balanced",
            advisorProfile: "frontier",
            callSites: {
              ...seededCallSites,
              recall: {
                ...seededCallSites.recall,
                disableCache: false,
              },
              customSite: { profile: "frontier" },
            },
          },
        },
        null,
        2,
      ) + "\n",
    );
    process.env.CADET_DEFAULT_WORKSPACE_CONFIG_PATH = overlayPath;

    const result = mergeDefaultWorkspaceConfig();
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as Record<
      string,
      Record<string, unknown>
    >;
    const llm = raw.llm as Record<string, unknown>;
    const callSites = llm.callSites as Record<string, Record<string, unknown>>;

    expect(result.hadOverlay).toBe(true);
    expect(raw.gateway).toEqual({
      unmappedPolicy: "default",
      defaultAssistantId: "self",
    });
    expect(llm.activeProfile).toBe("balanced");
    expect(llm.advisorProfile).toBe("frontier");
    expect(Object.keys(callSites).sort()).toEqual(["customSite", "recall"]);
    expect(callSites.recall?.disableCache).toBe(false);
    expect(callSites.customSite).toEqual({ profile: "frontier" });
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

  test("still writes a default config on first launch when file is absent", () => {
    // Discoverability: when no config.json exists, write one populated with
    // all schema defaults so users can see and edit available options.
    expect(existsSync(CONFIG_PATH)).toBe(false);

    getConfig();

    expect(existsSync(CONFIG_PATH)).toBe(true);
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    // Sanity: schema-defaulted nested fields are materialized
    expect(raw.memory?.v2?.bm25_b).toBe(0.4);
    expect(raw.dataDir).toBeUndefined();
  });

  test("off-cloud hatch writes no profile entries; defaults resolve through the hatch provider", () => {
    const overlayPath = join(WORKSPACE_DIR, "hatch-overlay.json");
    writeFileSync(
      overlayPath,
      JSON.stringify(
        {
          llm: {
            default: {
              provider: "anthropic",
              model: "claude-opus-4-7",
            },
          },
        },
        null,
        2,
      ) + "\n",
    );
    process.env.CADET_DEFAULT_WORKSPACE_CONFIG_PATH = overlayPath;
    const db = createProviderConnectionsDb();

    mergeDefaultConfigAndSeedInferenceProfiles(db);
    const config = getConfig();

    // `llm.default` is the base blob — the overlay blob reaches the parsed
    // config as a partial fragment and the seed never writes a separate key.
    expect(config.llm.default).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-7",
    });
    expect(config.llm.activeProfile).toBe("balanced");
    expect(config.llm.advisorProfile).toBe("quality-optimized");

    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    expect(raw.llm.default).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-7",
    });
    expect(raw.llm.activeProfile).toBe("balanced");
    // The hatch materializes no profile entries: default content is
    // code-owned and resolves through `llm.default`'s matrix column.
    for (const name of LEGACY_HATCH_PROFILE_NAMES) {
      expect(raw.llm.profiles[name]).toBeUndefined();
    }
    // The personal connection the BYOK column stamps is created at hatch.
    expect(getConnection(db, "anthropic-personal")).not.toBeNull();

    // Resolution contract the hatch relies on: the defaults resolve active
    // through the hatch provider with the personal connection.
    const effective = getEffectiveProfilesForProvider(LLMSchema.parse(raw.llm));
    expect(effective.balanced?.provider).toBe("anthropic");
    expect(effective.balanced?.provider_connection).toBe("anthropic-personal");
    expect(effective.balanced?.model).toBe("claude-sonnet-4-6");
    expect("status" in (effective.balanced ?? {})).toBe(false);
  });

  test("on-cloud hatch writes no profile entries; defaults resolve from the catalog", () => {
    process.env.IS_CLOUD = "true";

    const overlayPath = join(WORKSPACE_DIR, "hatch-overlay.json");
    writeFileSync(
      overlayPath,
      JSON.stringify(
        {
          llm: {
            default: {
              provider: "anthropic",
              model: "claude-opus-4-7",
            },
          },
        },
        null,
        2,
      ) + "\n",
    );
    process.env.CADET_DEFAULT_WORKSPACE_CONFIG_PATH = overlayPath;

    mergeDefaultConfigAndSeedInferenceProfiles();
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    expect(raw.llm.activeProfile).toBe("balanced");
    expect(raw.llm.advisorProfile).toBe("quality-optimized");
    // Platform installs materialize no managed entries and no user profiles —
    // llm.profiles holds only user/custom entries (none here).
    expect(raw.llm.profiles).toEqual({});
    // Default content resolves from the code catalog via the effective view.
    const effectiveBalanced = getEffectiveProfile(raw.llm.profiles, "balanced");
    expect(effectiveBalanced?.model).toBe(MANAGED_BALANCED_MODEL);
    expect(effectiveBalanced?.provider).toBe("cadet");
    expect(effectiveBalanced?.provider_connection).toBeUndefined();
  });

  test("re-hatch from openai to anthropic leaves the user profile untouched and re-anchors the defaults", () => {
    // Pre-seed an OpenAI-style workspace: user-defined custom-balanced profile
    // is active, default is openai. Simulates a workspace that hatched against
    // OpenAI under the pre-1.2 model.
    writeConfig({
      llm: {
        default: { provider: "openai", model: "gpt-5.4-mini" },
        profiles: {
          "custom-balanced": {
            provider: "openai",
            model: "gpt-5.4-mini",
          },
        },
        activeProfile: "custom-balanced",
      },
    });

    const overlayPath = join(WORKSPACE_DIR, "rehatch-anthropic.json");
    writeFileSync(
      overlayPath,
      JSON.stringify({ llm: { default: { provider: "anthropic" } } }, null, 2) +
        "\n",
    );
    process.env.CADET_DEFAULT_WORKSPACE_CONFIG_PATH = overlayPath;

    mergeDefaultConfigAndSeedInferenceProfiles();

    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    // Off-platform re-hatch: the default profiles become active, anchored on
    // the new hatch provider. The overlay's provider merges over the
    // existing blob and the old model rides (fragment-merge semantics — the
    // defaults themselves re-anchor through the provider's matrix column).
    expect(raw.llm.activeProfile).toBe("balanced");
    expect(raw.llm.default).toEqual({
      provider: "anthropic",
      model: "gpt-5.4-mini",
    });
    // The pre-existing custom profile is user-owned and never rewritten.
    expect(raw.llm.profiles["custom-balanced"]).toEqual({
      provider: "openai",
      model: "gpt-5.4-mini",
    });
    // No stubs under the default keys; content resolves through the new
    // default provider's matrix column.
    expect(raw.llm.profiles.balanced).toBeUndefined();
    const effective = getEffectiveProfilesForProvider(LLMSchema.parse(raw.llm));
    expect(effective.balanced?.provider).toBe("anthropic");
    expect(effective.balanced?.provider_connection).toBe("anthropic-personal");
  });

  test("on-cloud re-hatch resets active profile to balanced", () => {
    process.env.IS_CLOUD = "true";

    writeConfig({
      llm: {
        default: { provider: "openai", model: "gpt-5.4-mini" },
        profiles: {
          "custom-balanced": {
            provider: "openai",
            model: "gpt-5.4-mini",
          },
        },
        activeProfile: "custom-balanced",
      },
    });

    const overlayPath = join(WORKSPACE_DIR, "rehatch-anthropic.json");
    writeFileSync(
      overlayPath,
      JSON.stringify({ llm: { default: { provider: "anthropic" } } }, null, 2) +
        "\n",
    );
    process.env.CADET_DEFAULT_WORKSPACE_CONFIG_PATH = overlayPath;

    mergeDefaultConfigAndSeedInferenceProfiles();

    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    // On-platform: no user profiles created, active resets to managed balanced.
    expect(raw.llm.activeProfile).toBe("balanced");
    // No managed entry is materialized; content resolves from the catalog.
    expect(raw.llm.profiles.balanced).toBeUndefined();
    const effectiveBalanced = getEffectiveProfile(raw.llm.profiles, "balanced");
    expect(effectiveBalanced?.provider).toBe("cadet");
    expect(effectiveBalanced?.provider_connection).toBeUndefined();
    // The old custom-balanced is preserved on disk but no longer active.
    expect(raw.llm.profiles["custom-balanced"].provider).toBe("openai");
  });

  test("hatch overlay active profile must be dispatchable to be preserved", () => {
    const overlayPath = join(WORKSPACE_DIR, "hatch-overlay.json");
    writeFileSync(
      overlayPath,
      JSON.stringify(
        {
          llm: {
            default: { provider: "anthropic", model: "claude-opus-4-7" },
            profiles: {
              placeholder: { label: "Placeholder" },
            },
            profileOrder: ["placeholder"],
            activeProfile: "placeholder",
          },
        },
        null,
        2,
      ) + "\n",
    );
    process.env.CADET_DEFAULT_WORKSPACE_CONFIG_PATH = overlayPath;

    mergeDefaultConfigAndSeedInferenceProfiles();
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

    mergeDefaultConfigAndSeedInferenceProfiles();
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

  test("preserves user-supplied non-catalog model on every restart (ollama custom model)", () => {
    // Models the ollama case: catalog lists only `llama3.2` but the user has
    // pulled `codellama`. The seeder must NOT silently overwrite their pick.
    writeConfig({
      llm: { default: { provider: "ollama", model: "codellama" } },
    });

    mergeDefaultConfigAndSeedInferenceProfiles();
    let raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    expect(raw.llm.default.model).toBe("codellama");

    // Re-run to confirm idempotency — the user's model survives every restart.
    mergeDefaultConfigAndSeedInferenceProfiles();
    raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    expect(raw.llm.default.model).toBe("codellama");
  });

  test("off-cloud hatch with openai resolves the defaults through the openai column", () => {
    const overlayPath = join(WORKSPACE_DIR, "hatch-overlay.json");
    writeFileSync(
      overlayPath,
      JSON.stringify({ llm: { default: { provider: "openai" } } }, null, 2) +
        "\n",
    );
    process.env.CADET_DEFAULT_WORKSPACE_CONFIG_PATH = overlayPath;

    mergeDefaultConfigAndSeedInferenceProfiles();
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
    const overlayPath = join(WORKSPACE_DIR, "hatch-overlay.json");
    writeFileSync(
      overlayPath,
      JSON.stringify({ llm: { default: { provider: "together" } } }, null, 2) +
        "\n",
    );
    process.env.CADET_DEFAULT_WORKSPACE_CONFIG_PATH = overlayPath;
    const db = createProviderConnectionsDb();

    mergeDefaultConfigAndSeedInferenceProfiles(db);
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
    // defaults anchor on anthropic. litellm and opencode used to be the
    // subjects here — both are first-class default-provider choices now, so
    // a hatch anchored on either writes that provider directly (see the
    // litellm hatch test above).
    const overlayPath = join(WORKSPACE_DIR, "hatch-overlay.json");
    writeFileSync(
      overlayPath,
      JSON.stringify({ llm: { default: { provider: "typesafe" } } }, null, 2) +
        "\n",
    );
    process.env.CADET_DEFAULT_WORKSPACE_CONFIG_PATH = overlayPath;
    const db = createProviderConnectionsDb();

    mergeDefaultConfigAndSeedInferenceProfiles(db);
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
    mergeDefaultConfigAndSeedInferenceProfiles();
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

    mergeDefaultConfigAndSeedInferenceProfiles();
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
    mergeDefaultConfigAndSeedInferenceProfiles();
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

    mergeDefaultConfigAndSeedInferenceProfiles();
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

    mergeDefaultConfigAndSeedInferenceProfiles();
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

    mergeDefaultConfigAndSeedInferenceProfiles();
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

    mergeDefaultConfigAndSeedInferenceProfiles();
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

    mergeDefaultConfigAndSeedInferenceProfiles();
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

    mergeDefaultConfigAndSeedInferenceProfiles();
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    expect(raw.llm.profiles.balanced.label).toBeNull();
  });

  test("non-hatch off-cloud boot writes no managed entries; defaults resolve bare-labeled from the catalog", () => {
    // First boot of a config with no prior profiles and no hatch overlay:
    // nothing is materialized for the default names. The " (Managed)" label
    // suffix exists only on the thin stubs written at BYOK hatch time; a
    // plain boot serves the bare catalog labels through the effective view.
    writeConfig({});

    mergeDefaultConfigAndSeedInferenceProfiles();
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    expect(raw.llm.profiles.balanced).toBeUndefined();
    const effectiveBalanced = getEffectiveProfile(raw.llm.profiles, "balanced");
    expect(effectiveBalanced?.label).toBe("Balanced");
    expect(effectiveBalanced?.model).toBe(MANAGED_BALANCED_MODEL);
    // Status is unset — the default resolves active.
    expect("status" in (effectiveBalanced ?? {})).toBe(false);
  });

  test("platform overlay fragment stays on disk verbatim; resolution serves catalog content with the overlay label", () => {
    // The overlay's `balanced` fragment lands verbatim on disk and stays
    // there across boots — boots never rewrite managed entries. Resolution,
    // however, always serves default profile CONTENT from the code catalog:
    // a cloud-source workspace entry contributes only label/status/topP,
    // so the overlay's provider/model never reach the resolver. Only its
    // `label` shows through the effective view.
    process.env.IS_CLOUD = "true";

    writeConfig({
      llm: {
        default: {
          provider: "anthropic",
          model: "claude-opus-4-7",
        },
        profiles: {
          balanced: {
            provider: "cadet",
            model: "claude-sonnet-4-6",
            maxTokens: 16000,
            effort: "high",
            thinking: { enabled: true, streamThinking: true },
          },
        },
        activeProfile: "balanced",
      },
    });

    const overlayPath = join(WORKSPACE_DIR, "hatch-overlay.json");
    writeFileSync(
      overlayPath,
      JSON.stringify(
        {
          llm: {
            default: {
              provider: "cadet",
              model: "gpt-5.4",
            },
            profiles: {
              balanced: {
                provider: "cadet",
                model: "gpt-5.4",
                label: "Cloud Balanced",
              },
            },
            activeProfile: "balanced",
          },
        },
        null,
        2,
      ) + "\n",
    );
    process.env.CADET_DEFAULT_WORKSPACE_CONFIG_PATH = overlayPath;

    mergeDefaultConfigAndSeedInferenceProfiles();
    const config = getConfig();
    const mainAgentConfig = resolveCallSiteConfig("mainAgent", config.llm);

    // Hatch boot: overlay fragment is preserved verbatim on disk
    // (preserveProfileNames).
    expect(config.llm.activeProfile).toBe("balanced");
    expect(config.llm.profiles.balanced).toEqual({
      provider: "cadet",
      model: "gpt-5.4",
      label: "Cloud Balanced",
    });
    // Resolution serves default-profile CONTENT from the code catalog: the
    // overlay's provider/model never reach the resolver — even on the
    // overlay boot. The overlay-set label is what shows through the
    // effective view.
    expect(mainAgentConfig.provider).toBe("cadet");
    expect(mainAgentConfig.model).toBe(MANAGED_BALANCED_MODEL);

    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    expect(raw.llm.profiles.balanced).toEqual({
      provider: "cadet",
      model: "gpt-5.4",
      label: "Cloud Balanced",
    });
    expect(raw.llm.profiles.balanced.maxTokens).toBeUndefined();
    expect(raw.llm.profiles.balanced.thinking).toBeUndefined();

    // Next boot, no overlay: the entry stays byte-identical on disk, and
    // resolution keeps serving the fireworks-managed catalog body with the
    // overlay's label on top.
    mergeDefaultConfigAndSeedInferenceProfiles();

    const afterRestart = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    expect(afterRestart.llm.activeProfile).toBe("balanced");
    expect(afterRestart.llm.profiles.balanced).toEqual({
      provider: "cadet",
      model: "gpt-5.4",
      label: "Cloud Balanced",
    });
    const effectiveBalanced = getEffectiveProfile(
      afterRestart.llm.profiles,
      "balanced",
    );
    expect(effectiveBalanced?.provider).toBe("cadet");
    expect(effectiveBalanced?.provider_connection).toBeUndefined();
    expect(effectiveBalanced?.model).toBe(MANAGED_BALANCED_MODEL);
    expect(effectiveBalanced?.maxTokens).toBe(32000);
    expect(effectiveBalanced?.thinking).toEqual({
      enabled: true,
      streamThinking: true,
    });
    expect(effectiveBalanced?.label).toBe("Cloud Balanced");
  });

  test("quarantines corrupt config before merging hatch overlay", () => {
    writeFileSync(CONFIG_PATH, "{not valid json");

    const overlayPath = join(WORKSPACE_DIR, "hatch-overlay.json");
    writeFileSync(
      overlayPath,
      JSON.stringify(
        {
          llm: {
            default: {
              provider: "anthropic",
              model: "claude-opus-4-7",
            },
          },
        },
        null,
        2,
      ) + "\n",
    );
    process.env.CADET_DEFAULT_WORKSPACE_CONFIG_PATH = overlayPath;

    mergeDefaultConfigAndSeedInferenceProfiles();

    const quarantined = readdirSync(WORKSPACE_DIR).filter((n) =>
      n.startsWith("config.json.corrupt-"),
    );
    expect(quarantined.length).toBeGreaterThan(0);

    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    expect(raw.llm.default).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-7",
    });
    // Off-platform hatch: nothing is materialized; the defaults resolve
    // through the hatch provider. The overlay's blob lands verbatim.
    expect(raw.llm.activeProfile).toBe("balanced");
    expect(raw.llm.default).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-7",
    });
    for (const name of LEGACY_HATCH_PROFILE_NAMES) {
      expect(raw.llm.profiles[name]).toBeUndefined();
    }
    const effective = getEffectiveProfilesForProvider(LLMSchema.parse(raw.llm));
    expect(effective.balanced?.provider).toBe("anthropic");
    expect(effective.balanced?.provider_connection).toBe("anthropic-personal");
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

    mergeDefaultConfigAndSeedInferenceProfiles();

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

    mergeDefaultConfigAndSeedInferenceProfiles();

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

  test("still quarantines corrupt JSON", () => {
    // Corrupt-config quarantine is a recovery path: the broken file is
    // renamed to `config.json.corrupt-<ts>.json` and the daemon proceeds
    // with defaults. This must keep working.
    writeFileSync(CONFIG_PATH, "{not valid json");

    getConfig();

    // A new defaults-populated config.json is written in place
    expect(existsSync(CONFIG_PATH)).toBe(true);
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    expect(raw.memory?.v2?.bm25_b).toBe(0.4);

    // The corrupt original is preserved as a `*.corrupt-*.json` sibling
    const quarantined = readdirSync(WORKSPACE_DIR).filter((n) =>
      n.startsWith("config.json.corrupt-"),
    );
    expect(quarantined.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: BYOK-mode seed behavior. A BYOK hatch writes no profile entries at
// all: the default names resolve through the hatch provider's column of the
// intent × provider matrix (via `llm.default`), active and
// connection-stamped. Boots never touch managed entries, so pre-existing
// stubs and user toggles on them persist until the conversion pass removes
// them.
// ---------------------------------------------------------------------------

describe("seedInferenceProfiles BYOK-mode default profiles", () => {
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
    ensureTestDir();
    delete process.env.CADET_DEFAULT_WORKSPACE_CONFIG_PATH;
    delete process.env.IS_CLOUD;
    invalidateConfigCache();
  });

  afterEach(() => {
    delete process.env.CADET_DEFAULT_WORKSPACE_CONFIG_PATH;
    delete process.env.IS_CLOUD;
    invalidateConfigCache();
  });

  test("off-cloud hatch writes no stubs; defaults resolve active with bare labels", () => {
    const overlayPath = join(WORKSPACE_DIR, "hatch-overlay.json");
    writeFileSync(
      overlayPath,
      JSON.stringify(
        {
          llm: {
            default: { provider: "anthropic", model: "claude-opus-4-7" },
          },
        },
        null,
        2,
      ) + "\n",
    );
    process.env.CADET_DEFAULT_WORKSPACE_CONFIG_PATH = overlayPath;

    mergeDefaultConfigAndSeedInferenceProfiles();
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    // No workspace entries at all: no disabled stubs, no label suffixes, no
    // custom-* copies. The catalog serves the bare labels, active.
    expect(raw.llm.profiles).toEqual({});
    const effective = getEffectiveProfilesForProvider(LLMSchema.parse(raw.llm));
    expect(effective.balanced?.label).toBe("Balanced");
    expect(effective["quality-optimized"]?.label).toBe("Quality");
    expect(effective["cost-optimized"]?.label).toBe("Budget");
    expect("status" in (effective.balanced ?? {})).toBe(false);
    expect("status" in (effective["quality-optimized"] ?? {})).toBe(false);
    expect("status" in (effective["cost-optimized"] ?? {})).toBe(false);
  });

  test("off-cloud BYOK hatch defaults advisor to quality-optimized", () => {
    const overlayPath = join(WORKSPACE_DIR, "hatch-overlay.json");
    writeFileSync(
      overlayPath,
      JSON.stringify({ llm: { default: { provider: "anthropic" } } }, null, 2) +
        "\n",
    );
    process.env.CADET_DEFAULT_WORKSPACE_CONFIG_PATH = overlayPath;

    mergeDefaultConfigAndSeedInferenceProfiles();
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

    mergeDefaultConfigAndSeedInferenceProfiles();
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

    mergeDefaultConfigAndSeedInferenceProfiles();
    const config = getConfig();

    expect(config.llm.advisorProfile).toBe("quality-optimized");
  });

  test("off-cloud boot clears a disabled managed advisor when no active replacement exists", () => {
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
        },
      },
    });

    mergeDefaultConfigAndSeedInferenceProfiles();
    const config = getConfig();

    expect(config.llm.advisorProfile).toBeUndefined();
  });

  test("off-cloud managed-inference hatch keeps selected cloud connection active", () => {
    const overlayPath = join(WORKSPACE_DIR, "hatch-overlay.json");
    writeFileSync(
      overlayPath,
      JSON.stringify(
        {
          llm: {
            default: { provider: "anthropic" },
            activeProfile: "balanced",
          },
        },
        null,
        2,
      ) + "\n",
    );
    process.env.CADET_DEFAULT_WORKSPACE_CONFIG_PATH = overlayPath;
    const db = createProviderConnectionsDb();

    mergeDefaultConfigAndSeedInferenceProfiles(db);
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    expect(raw.llm.activeProfile).toBe("balanced");
    // The hatch overlay selected a cloud profile (all cloud profiles
    // share the single `cadet` connection), so no disabled stubs are
    // written: the defaults stay absent from llm.profiles and resolve active
    // from the code catalog. The default advisor falls to the strongest
    // active cloud profile, `quality-optimized`.
    expect(raw.llm.advisorProfile).toBe("quality-optimized");
    expect(raw.llm.profiles.balanced).toBeUndefined();
    const effectiveBalanced = getEffectiveProfile(raw.llm.profiles, "balanced");
    expect(effectiveBalanced?.provider_connection).toBeUndefined();
    expect("status" in (effectiveBalanced ?? {})).toBe(false);
  });

  test("off-cloud managed-inference hatch respects explicit non-managed active connection", () => {
    const overlayPath = join(WORKSPACE_DIR, "hatch-overlay.json");
    writeFileSync(
      overlayPath,
      JSON.stringify(
        {
          llm: {
            default: { provider: "anthropic" },
            profiles: {
              balanced: {
                provider: "cadet",
                provider_connection: "anthropic-personal",
                model: "claude-sonnet-4-6",
              },
            },
            activeProfile: "balanced",
          },
        },
        null,
        2,
      ) + "\n",
    );
    process.env.CADET_DEFAULT_WORKSPACE_CONFIG_PATH = overlayPath;
    const db = createProviderConnectionsDb();

    mergeDefaultConfigAndSeedInferenceProfiles(db);
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

  test("non-hatch off-cloud boot writes no managed entries and never auto-disables the defaults", () => {
    // Existing installs that upgrade to a version where the workspace
    // carries no entries for the default names get nothing materialized on
    // a normal boot — and therefore nothing auto-disabled. The disabled
    // stubs are written only at BYOK hatch time; without an overlay there
    // is no hatch signal, and the defaults resolve active from the code
    // catalog. This is the "we never want to auto-disable BYOK connections
    // on restart" guarantee.
    writeConfig({
      llm: {
        default: { provider: "anthropic", model: "claude-opus-4-7" },
        // Note: no `profiles` key — the default names stay absent from the
        // workspace after the boot.
      },
    });

    // No overlay → not a hatch.
    mergeDefaultConfigAndSeedInferenceProfiles();
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

    expect(raw.llm.profiles.balanced).toBeUndefined();
    expect(raw.llm.profiles["quality-optimized"]).toBeUndefined();
    expect(raw.llm.profiles["cost-optimized"]).toBeUndefined();
    const effective = getEffectiveProfiles(raw.llm.profiles);
    expect("status" in (effective.balanced ?? {})).toBe(false);
    expect("status" in (effective["quality-optimized"] ?? {})).toBe(false);
    expect("status" in (effective["cost-optimized"] ?? {})).toBe(false);
  });

  test("on-cloud hatch writes no managed stubs; catalog labels stay bare", () => {
    process.env.IS_CLOUD = "true";

    const overlayPath = join(WORKSPACE_DIR, "hatch-overlay.json");
    writeFileSync(
      overlayPath,
      JSON.stringify({ llm: { default: { provider: "anthropic" } } }, null, 2) +
        "\n",
    );
    process.env.CADET_DEFAULT_WORKSPACE_CONFIG_PATH = overlayPath;

    mergeDefaultConfigAndSeedInferenceProfiles();
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

    mergeDefaultConfigAndSeedInferenceProfiles();
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
    mergeDefaultConfigAndSeedInferenceProfiles();
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

    mergeDefaultConfigAndSeedInferenceProfiles();
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

    mergeDefaultConfigAndSeedInferenceProfiles();
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
    mergeDefaultConfigAndSeedInferenceProfiles();
    const config = getConfig();

    // User's "active" decision survives the boot upsert.
    expect(config.llm.profiles.balanced?.status).toBe("active");
    // Label is still suffixed (Cadet can push label updates).
    expect(config.llm.profiles.balanced?.label).toBe("Balanced (Managed)");
  });
});
