/**
 * Parity guard for the web LLM model catalog: enforces full parity with
 * `meta/llm-provider-catalog.json` (the canonical catalog generated from the
 * daemon's `assistant/src/providers/model-catalog.ts`) so this
 * hand-maintained mirror can never silently drift again.
 *
 * Covers every catalog surface the web UI consumes: per-model fields
 * (ids, order, display names, token limits, thinking flags), per-provider
 * default models, the provider display-name and cloud-auth maps, the
 * INFERENCE_PROVIDERS picker list in constants.ts, and the
 * CONNECTION_PROVIDERS picker list in provider-editor-constants.ts.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { INFERENCE_PROVIDERS } from "@/domains/settings/ai/constants";
import { CONNECTION_PROVIDERS } from "@/domains/settings/ai/provider-editor-constants";

import {
  CODEX_SUBSCRIPTION_MODEL_IDS,
  DEFAULT_MODEL_BY_PROVIDER,
  getDefaultModelForProvider,
  MODELS_BY_PROVIDER,
  PROVIDER_DISPLAY_NAMES,
  PROVIDER_SUPPORTS_PLATFORM_AUTH,
  getModelsForProvider,
  catalogModelSupportsText,
  getTextGenerationModelsForProvider,
  getCloudUpstreamForModel,
  providerOffersTextGeneration,
  CADET_SERVED_PROVIDERS,
  type LlmProviderId,
} from "./llm-model-catalog";

// ---------------------------------------------------------------------------
// Parity with meta/llm-provider-catalog.json
// ---------------------------------------------------------------------------

interface MetaCatalogModel {
  id: string;
  displayName: string;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  defaultContextWindowTokens?: number;
  longContextPricingThresholdTokens?: number;
  supportsThinking?: boolean;
  adaptiveThinkingOnly?: boolean;
  thinkingFloor?: "minimal" | "low";
  supportsText?: boolean;
}

interface MetaCatalogProvider {
  id: string;
  displayName: string;
  supportsCloudAuth?: boolean;
  defaultModel: string;
  models: MetaCatalogModel[];
}

interface MetaCatalog {
  version: number;
  providers: MetaCatalogProvider[];
}

// bun:test runs in Bun, so direct filesystem access works here — same
// technique as the daemon's assistant/src/__tests__/llm-catalog-parity.test.ts.
const META_CATALOG_PATH = join(
  import.meta.dir,
  "../../../../meta/llm-provider-catalog.json",
);

/**
 * Project a model down to the fields the web UI uses. The web mirror omits
 * capability fields the UI doesn't render (vision/caching/toolUse/pricing),
 * so only the shared subset is compared. `supportsThinking` and
 * `adaptiveThinkingOnly` are normalized to booleans because the web mirror
 * omits them when false while the meta JSON may carry an explicit `false`.
 * `supportsText` is the inverse: omitted means true, and only an explicit
 * `false` is compared.
 */
function comparableModel(model: MetaCatalogModel) {
  return {
    id: model.id,
    displayName: model.displayName,
    contextWindowTokens: model.contextWindowTokens,
    maxOutputTokens: model.maxOutputTokens,
    defaultContextWindowTokens: model.defaultContextWindowTokens,
    longContextPricingThresholdTokens: model.longContextPricingThresholdTokens,
    supportsThinking: model.supportsThinking === true,
    adaptiveThinkingOnly: model.adaptiveThinkingOnly === true,
    thinkingFloor: model.thinkingFloor,
    supportsText: model.supportsText !== false,
  };
}

describe("chatgpt identity catalog", () => {
  test("serves the openai catalog restricted to the Codex set", () => {
    const models = getModelsForProvider("chatgpt");
    expect(models.length).toBeGreaterThan(0);
    const openaiIds = new Set(getModelsForProvider("openai").map((m) => m.id));
    for (const m of models) {
      expect(openaiIds.has(m.id)).toBe(true);
      expect(CODEX_SUBSCRIPTION_MODEL_IDS.has(m.id)).toBe(true);
    }
    expect(models.some((m) => m.id === "gpt-5.4-nano")).toBe(false);
    expect(models.some((m) => m.id === "gpt-5.4")).toBe(false);
    expect(models.some((m) => m.id === "gpt-5.4-mini")).toBe(false);
  });

  test("defaults to the Balanced profile's model on the chatgpt column", () => {
    expect(getDefaultModelForProvider("chatgpt")).toBe("gpt-5.6-luna");
  });
});

describe("parity with meta/llm-provider-catalog.json", () => {
  // Intentional asymmetry between the web mirror and the meta catalog:
  // openai-compatible has a per-connection model list, so its (empty)
  // catalog entry is excluded from model/default comparisons.
  // Field parity therefore iterates web keys, not meta providers; the
  // coverage test below guards the reverse direction.
  const metaCatalog: MetaCatalog = JSON.parse(
    readFileSync(META_CATALOG_PATH, "utf-8"),
  );
  const metaProvidersById = new Map(
    metaCatalog.providers.map((provider) => [provider.id, provider]),
  );
  const webProviderIds = (
    Object.keys(MODELS_BY_PROVIDER) as LlmProviderId[]
  ).filter((id) => id !== "openai-compatible");
  const pickerProviderIds = webProviderIds;

  test("cadet picker is the union of served catalogs", () => {
    // The picker exposes the union of every served catalog through
    // getModelsForProvider("cadet").
    const cadetModels = getModelsForProvider("cadet");
    const servedIds = new Set<string>(
      CADET_SERVED_PROVIDERS.flatMap((p) =>
        MODELS_BY_PROVIDER[p].map((m) => m.id),
      ),
    );
    for (const model of cadetModels) {
      expect(servedIds.has(model.id)).toBe(true);
    }
    const labels = cadetModels.map((m) => m.displayName);
    expect(new Set(labels).size).toBe(labels.length);
    const servedLabels = new Set(
      CADET_SERVED_PROVIDERS.flatMap((p) =>
        MODELS_BY_PROVIDER[p].map((m) => m.displayName),
      ),
    );
    expect(new Set(labels)).toEqual(servedLabels);
  });

  test("getCloudUpstreamForModel derives the serving provider", () => {
    expect(getCloudUpstreamForModel("claude-opus-4-8")).toBe("anthropic");
    expect(
      getCloudUpstreamForModel("accounts/fireworks/models/glm-5p3"),
    ).toBe("fireworks");
    expect(getCloudUpstreamForModel("not-a-real-model")).toBeUndefined();
  });

  test("structured-decision models stay visible on the provider row but not in text pickers", () => {
    expect(
      getModelsForProvider("typesafe").some(
        (model) => model.id === "jev-latest",
      ),
    ).toBe(true);
    expect(catalogModelSupportsText("typesafe", "jev-latest")).toBe(false);
    expect(providerOffersTextGeneration("typesafe")).toBe(false);
    expect(providerOffersTextGeneration("anthropic")).toBe(true);
    expect(providerOffersTextGeneration("openai-compatible")).toBe(true);
    expect(getTextGenerationModelsForProvider("typesafe")).toEqual([]);
    expect(
      getModelsForProvider("typesafe").some((model) => model.id === "jev-latest"),
    ).toBe(true);
  });

  test("every meta provider exists in the web mirror", () => {
    // This is the original MiniMax bug: a provider added to the daemon
    // catalog but never mirrored here, leaving an empty Model dropdown.
    const webKeys = new Set<string>(Object.keys(MODELS_BY_PROVIDER));
    for (const provider of metaCatalog.providers) {
      expect(
        webKeys.has(provider.id),
        `meta provider "${provider.id}" is missing from MODELS_BY_PROVIDER`,
      ).toBe(true);
    }
  });

  test("provider display names match the meta catalog", () => {
    // The display-name map deliberately covers every daemon provider
    // (including daemon-only ones like ollama), so this iterates the full
    // meta catalog — the same stale-map drift class as the original bug.
    for (const provider of metaCatalog.providers) {
      expect(
        PROVIDER_DISPLAY_NAMES[provider.id],
        `PROVIDER_DISPLAY_NAMES["${provider.id}"] drifted from meta`,
      ).toBe(provider.displayName);
    }
  });

  test("provider cloud-auth support matches the meta catalog", () => {
    // Like the display-name map, this covers every daemon provider so the
    // connection editor can filter auth types for daemon-only providers.
    // Normalized to boolean: missing entries on either side mean `false`.
    for (const provider of metaCatalog.providers) {
      expect(
        PROVIDER_SUPPORTS_PLATFORM_AUTH[provider.id],
        `PROVIDER_SUPPORTS_PLATFORM_AUTH["${provider.id}"] drifted from meta`,
      ).toBe(provider.supportsCloudAuth === true);
    }
  });

  test("INFERENCE_PROVIDERS covers every web catalog provider", () => {
    // The call-site overrides picker is driven by INFERENCE_PROVIDERS in
    // constants.ts. It must list exactly the catalog providers (minus the
    // free-form openai-compatible escape hatch) or a provider becomes
    // unselectable there. Order is not asserted: the list's order is the
    // picker's display order (a UI choice, with index 0 as the default
    // fallback), not the catalog's.
    expect([...INFERENCE_PROVIDERS].sort()).toEqual(
      [...pickerProviderIds].sort(),
    );
  });

  test("CONNECTION_PROVIDERS covers every meta catalog provider except cadet", () => {
    // The connection-creation picker is driven by CONNECTION_PROVIDERS in
    // provider-editor-constants.ts. Unlike INFERENCE_PROVIDERS, it
    // intentionally includes daemon-only providers (ollama) and the
    // free-form openai-compatible escape hatch — any daemon provider can
    // back a connection — so it must list exactly the meta catalog's
    // provider ids or a provider becomes un-creatable as a connection.
    // `cadet` is excluded: those models use the assistant API key on the
    // existing cloud connection and have no BYOK create path.
    // Order is not asserted: the list's order is the picker's display order.
    const connectionProviderIds: string[] = [...CONNECTION_PROVIDERS];
    expect(connectionProviderIds.sort()).toEqual(
      metaCatalog.providers
        .map((provider) => provider.id)
        .filter((id) => id !== "cadet")
        .sort(),
    );
  });

  for (const providerId of webProviderIds) {
    describe(providerId, () => {
      const metaProvider = metaProvidersById.get(providerId);

      test("exists in the meta catalog", () => {
        expect(
          metaProvider,
          `web provider "${providerId}" has no meta catalog entry`,
        ).toBeDefined();
      });

      test("models match the meta catalog (ids, order, and shared fields)", () => {
        expect(getModelsForProvider(providerId).map(comparableModel)).toEqual(
          (metaProvider?.models ?? []).map(comparableModel),
        );
      });

      test("default model matches the meta catalog", () => {
        expect(metaProvider?.defaultModel).toBe(
          DEFAULT_MODEL_BY_PROVIDER[providerId],
        );
      });
    });
  }
});
