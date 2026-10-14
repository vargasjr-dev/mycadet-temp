/**
 * Route definitions for model configuration, embedding configuration,
 * conversation search, message content, LLM
 * context inspection, and queued message deletion.
 *
 * GET    /v1/model                      — current model info
 * PUT    /v1/model/image-gen            — set image-gen model
 * GET    /v1/config/embeddings          — current embedding config
 * PUT    /v1/config/embeddings          - set embedding provider/model/baseUrl
 * GET    /v1/config                     — full raw workspace config
 * PATCH  /v1/config                     — deep-merge partial config
 * PUT    /v1/config/llm/profiles/:name  — replace an inference profile
 * GET    /v1/conversations/search       — search conversations
 * GET    /v1/messages/:id/content       — full message content
 * GET    /v1/messages/:id/llm-context   — LLM request logs for a message
 * GET    /v1/llm-request-logs/:id/payload — raw payload for a single log
 * GET    /v1/llm-request-logs/:id/context — normalized context for a single log
 * DELETE /v1/messages/queued/:id        — delete queued message
 * POST   /v1/messages/queued/:id/steer — steer to a queued message
 */

import { z } from "zod";

import { LlmContextResponseSchema } from "../../api/responses/llm-context-response.js";
import {
  type LatencyBreakdown,
  LatencyBreakdownSchema,
  LLMRequestLogEntrySchema,
} from "../../api/responses/llm-request-log-entry.js";
import { scrubNulledAcpAgentLeaves } from "../../config/acp-agent-write.js";
import {
  ChatSettingsPatchSchema,
  scrubNulledChatSettings,
  validateChatSettingsWrite,
} from "../../config/chat-settings.js";
import {
  deepMergeOverwrite,
  getConfig,
  invalidateConfigCache,
  loadRawConfig,
  saveRawConfig,
  setNestedValue,
  withSuppressedConfigDiskWrites,
  withSuppressedConfigDiskWritesSync,
} from "../../config/loader.js";
import {
  type AssistantConfig,
  AssistantConfigSchema,
} from "../../config/schema.js";
import { getSchemaAtPath } from "../../config/schema-utils.js";
import {
  LLMConfigFragment,
  LLMDefaultConfigSchema,
  LLMSchema,
  ProfileEntry,
  routingIdentityModelIssue,
  unknownLlmProviderIssue,
} from "../../config/schemas/llm.js";
import { VALID_MEMORY_EMBEDDING_PROVIDERS } from "../../config/schemas/memory-storage.js";
import { ServiceModeSchema } from "../../config/schemas/services.js";
import { isSidebarDoneEnabled } from "../../config/sidebar-done-gate.js";
import {
  describeShadowedConfigSet,
  findSubstrateShadowing,
} from "../../config/substrate-twin-shadowing.js";
import { getConfigWatcher } from "../../daemon/config-watcher.js";
import {
  getEmbeddingConfigInfo,
  setEmbeddingConfig,
} from "../../daemon/handlers/config-embeddings.js";
import { dropTunnelRecordsForNewUrl } from "../../daemon/handlers/config-ingress.js";
import {
  getModelInfo,
  type ModelSetContext,
  setImageGenModel,
} from "../../daemon/handlers/config-model.js";
import {
  getMessageContent,
  performConversationSearch,
} from "../../daemon/handlers/conversation-history.js";
import {
  deleteQueuedMessage,
  steerToMessage,
} from "../../daemon/handlers/conversations.js";
import {
  CONFIG_RELOAD_DEBOUNCE_MS,
  log,
} from "../../daemon/handlers/shared.js";
import { rescheduleHeartbeatIfTimezoneChanged } from "../../heartbeat/heartbeat-service.js";
import {
  getAssistantMessageIdsInTurn,
  getConversation,
  getMessageById,
} from "../../persistence/conversation-crud.js";
import { getConversationByKey } from "../../persistence/conversation-key-store.js";
import {
  type ConversationKind,
  resolveConversationKind,
} from "../../persistence/conversation-types.js";
import { getDb } from "../../persistence/db-connection.js";
import { clearEmbeddingBackendCache } from "../../persistence/embeddings/embedding-backend.js";
import { resolveOpenAICompatibleBaseUrl } from "../../persistence/embeddings/embedding-openai.js";
import { getLlmRequestLogSource } from "../../persistence/llm-request-log-source.js";
import { type LogRow } from "../../persistence/llm-request-log-store.js";
import { getMemoryRecallLogByMessageIds } from "../../plugins/defaults/memory/memory-recall-log-store.js";
import { getMemoryV2ActivationLogByMessageIds } from "../../plugins/defaults/memory/v2/activation-log-store.js";
import { getMemoryV3SelectionForInspectorByMessageIds } from "../../plugins/defaults/memory/v3/selection-log-store.js";
import { CLOUD_ROUTABLE_PROVIDERS } from "../../providers/cadet-model-routing.js";
import { writableProfileProviderIssue } from "../../providers/connection-resolution.js";
import { ROUTING_IDENTITY_PROVIDERS } from "../../providers/inference/auth.js";
import { PROVIDERS_REQUIRING_BASE_URL_AND_MODELS } from "../../providers/inference/auth.js";
import {
  CADET_CLOUD_CONNECTION_NAME,
  createConnection,
  getConnection,
  LEGACY_MANAGED_CONNECTION_NAMES,
  listConnections,
} from "../../providers/inference/connections.js";
import { initializeProviders } from "../../providers/registry.js";
import { credentialKey } from "../../security/credential-key.js";
import { validateAllowlistFile } from "../../security/secret-allowlist.js";
import {
  resolvePricingForUsage,
  usesAnthropicPricingRules,
} from "../../util/pricing.js";
import { resolveActorPrincipalIdForLocalGuardian } from "../local-actor-identity.js";
import { publishConfigChanged } from "../sync/resource-sync-events.js";
import {
  BadRequestError,
  ForbiddenError,
  InternalError,
  NotFoundError,
} from "./errors.js";
import {
  type LlmContextSummary,
  normalizeLlmContextPayloads,
} from "./llm-context-normalization.js";
import { assertLlmRequestLoggingEnabled } from "./llm-request-logs-access.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const validEmbeddingProviderSet = new Set<string>(
  VALID_MEMORY_EMBEDDING_PROVIDERS,
);

type LlmContextNormalizationResult = ReturnType<
  typeof normalizeLlmContextPayloads
>;

type LlmContextSummaryResponse = NonNullable<
  Omit<NonNullable<LlmContextNormalizationResult["summary"]>, "provider">
> & {
  provider: string;
};

type LlmContextRouteResult = Omit<LlmContextNormalizationResult, "summary"> & {
  summary?: LlmContextSummaryResponse;
};

import {
  CODE_OWNED_PROFILE_NAMES,
  getEffectiveProfilesForProvider,
  MANAGED_PROFILE_NAMES,
} from "../../config/default-profile-catalog.js";
import { DEFAULT_PROFILE_KEYS } from "../../config/default-profile-names.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";

const RESERVED_PROFILE_NAMES = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

const INFERENCE_PROFILE_UI_KEYS = new Set([
  "provider",
  "provider_connection",
  "model",
  "maxTokens",
  "effort",
  "speed",
  "verbosity",
  "temperature",
  "topP",
  "thinking",
]);

function asMutablePlainObject(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function mergeInferenceProfileContextWindow(
  existingProfile: Record<string, unknown>,
  fragment: Record<string, unknown>,
  nextProfile: Record<string, unknown>,
): void {
  const existingContextWindow =
    asMutablePlainObject(existingProfile.contextWindow) ?? {};
  const nextContextWindow: Record<string, unknown> = {
    ...existingContextWindow,
  };

  delete nextContextWindow.maxInputTokens;

  if (Object.hasOwn(fragment, "contextWindow")) {
    const fragmentContextWindow = asMutablePlainObject(fragment.contextWindow);
    if (
      fragmentContextWindow &&
      Object.hasOwn(fragmentContextWindow, "maxInputTokens")
    ) {
      nextContextWindow.maxInputTokens = fragmentContextWindow.maxInputTokens;
    }
  }

  if (Object.keys(nextContextWindow).length === 0) {
    delete nextProfile.contextWindow;
  } else {
    nextProfile.contextWindow = nextContextWindow;
  }
}

function replaceInferenceProfileConfig(
  raw: Record<string, unknown>,
  name: string,
  fragment: Record<string, unknown>,
): void {
  const existingLlm = asMutablePlainObject(raw.llm);
  const llm = existingLlm ?? {};
  if (!existingLlm) {
    raw.llm = llm;
  }

  const existingProfiles = asMutablePlainObject(llm.profiles);
  const profiles = existingProfiles ?? {};
  if (!existingProfiles) {
    llm.profiles = profiles;
  }

  const existingProfile = asMutablePlainObject(profiles[name]) ?? {};
  const nextProfile: Record<string, unknown> = { ...existingProfile };
  for (const key of INFERENCE_PROFILE_UI_KEYS) {
    delete nextProfile[key];
  }
  // Converting a profile to a mix is an explicit replacement: a mix carries
  // no model route of its own to fall back from, so an existing
  // `fallbackProfile` pointer is dropped rather than preserved alongside
  // `mix` (a combination `LLMSchema` rejects on the next full reload).
  if (fragment.mix != null) {
    delete nextProfile.fallbackProfile;
  }
  const fragmentTopLevel = { ...fragment };
  delete fragmentTopLevel.contextWindow;
  profiles[name] = { ...nextProfile, ...fragmentTopLevel };
  mergeInferenceProfileContextWindow(
    existingProfile,
    fragment,
    profiles[name] as Record<string, unknown>,
  );
}

function attachEstimatedCost(summary: LlmContextSummary): LlmContextSummary {
  const { provider, model, inputTokens, outputTokens } = summary;
  if (!model || inputTokens == null || outputTokens == null) {
    return summary;
  }

  const cacheCreation = summary.cacheCreationInputTokens ?? 0;
  const cacheRead = summary.cacheReadInputTokens ?? 0;
  // `inputTokens` carries provider-shape-dependent cache accounting. Anthropic
  // Messages responses (native and OpenRouter `anthropic/*`) report `input_tokens`
  // already net of cache — cache-creation/read are separate, additive buckets —
  // so the full-rate portion IS `inputTokens`. OpenAI/Gemini report a total
  // prompt-token count with cached tokens as a subset, so the full-rate portion
  // is the total minus cache. `usesAnthropicPricingRules` selects the same
  // response shapes the pricing layer treats as Anthropic (keyed on the stored
  // transport provider + model), so it also distinguishes the cache accounting.
  const directInputTokens = usesAnthropicPricingRules(provider, model)
    ? Math.max(inputTokens, 0)
    : Math.max(inputTokens - cacheCreation - cacheRead, 0);

  const result = resolvePricingForUsage(provider, model, {
    directInputTokens,
    outputTokens,
    cacheCreationInputTokens: cacheCreation,
    cacheReadInputTokens: cacheRead,
    anthropicCacheCreation: null,
  });

  return { ...summary, estimatedCostUsd: result.estimatedCostUsd };
}

function applyStoredProviderToLlmContextResult(
  normalized: LlmContextNormalizationResult,
  provider: string | null,
): LlmContextRouteResult {
  if (!provider) {
    const summary = normalized.summary
      ? attachEstimatedCost(normalized.summary)
      : undefined;
    return { ...normalized, summary } as LlmContextRouteResult;
  }

  const mergedSummary = normalized.summary
    ? { ...normalized.summary, provider }
    : { provider };
  const summary = attachEstimatedCost(mergedSummary as LlmContextSummary);
  return { ...normalized, summary };
}

/**
 * `full` returns the complete normalized entry including request/response
 * sections; `summary` omits the sections so list responses stay small —
 * sections for a single call are fetched lazily through
 * `/v1/llm-request-logs/{logId}/context`.
 */
type LlmContextView = "full" | "summary";

function resolveLlmContextView(view: string | undefined): LlmContextView {
  if (view === undefined || view === "full") {
    return "full";
  }
  if (view === "summary") {
    return "summary";
  }
  throw new BadRequestError(
    `Invalid view parameter: ${view}. Expected "full" or "summary".`,
  );
}

/**
 * Parse the stored `latency_breakdown` JSON into a validated
 * {@link LatencyBreakdown}. Returns `null` for the common no-data case and
 * for malformed/legacy rows — a bad blob must never break the inspector.
 */
function parseLatencyBreakdown(raw: string | null): LatencyBreakdown | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = LatencyBreakdownSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function normalizeLlmContextLog(
  log: LogRow,
  view: LlmContextView = "full",
): LlmContextRouteResult & {
  id: string;
  requestPayload: null;
  responsePayload: null;
  createdAt: number;
  agentLoopExitReason: string | null;
  callSite: string | null;
  latency: LatencyBreakdown | null;
} {
  let requestPayload: unknown;
  try {
    requestPayload = JSON.parse(log.requestPayload);
  } catch {
    requestPayload = log.requestPayload;
  }
  let responsePayload: unknown;
  try {
    responsePayload = JSON.parse(log.responsePayload);
  } catch {
    responsePayload = log.responsePayload;
  }
  const normalized = normalizeLlmContextPayloads({
    requestPayload,
    responsePayload,
    createdAt: log.createdAt,
  });
  const result = applyStoredProviderToLlmContextResult(
    normalized,
    log.provider,
  );
  return {
    id: log.id,
    requestPayload: null,
    responsePayload: null,
    createdAt: log.createdAt,
    // Agent-loop exit reason for the iteration that produced this call,
    // stamped onto the most-recent unstamped log by
    // `conversation-agent-loop-handlers.ts` after the loop yields. Only the
    // terminal call in each loop iteration carries a value; non-terminal calls
    // land here as `null`.
    agentLoopExitReason: log.agentLoopExitReason ?? null,
    // Logical call site (`mainAgent`, `compactionAgent`,
    // `syntheticAgentErrorMessage`, …). Exposed to the inspector so synthetic
    // rows can be rendered distinctly without re-deriving the kind from
    // other fields — the frontend branches on this value alone, and the
    // existing `agent_loop_exit_reason` column tells it WHICH error fired.
    callSite: log.callSite ?? null,
    // Daemon-measured first-token latency waterfall, stamped on the row at
    // record time (like `callSite`) rather than derived from the payloads.
    latency: parseLatencyBreakdown(log.latencyBreakdown),
    ...result,
    ...(view === "summary"
      ? { requestSections: undefined, responseSections: undefined }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Model set context — derived directly from the config watcher singleton
// ---------------------------------------------------------------------------

function getModelSetContext(): ModelSetContext {
  const watcher = getConfigWatcher();
  return {
    suppressConfigReload: watcher.suppressConfigReload,
    setSuppressConfigReload(value: boolean) {
      watcher.suppressConfigReload = value;
    },
    updateConfigFingerprint() {
      withSuppressedConfigDiskWritesSync(() => watcher.updateFingerprint());
    },
    debounceTimers: watcher.timers,
  };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleGetModel() {
  return getModelInfo();
}

async function handleSetImageGenModel({ body }: RouteHandlerArgs) {
  if (!body || typeof body !== "object") {
    throw new BadRequestError("Request body is required");
  }
  const { modelId } = body as { modelId?: string };
  if (!modelId || typeof modelId !== "string") {
    throw new BadRequestError("Missing required field: modelId");
  }
  try {
    setImageGenModel(modelId, getModelSetContext());
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new InternalError(`Failed to set image gen model: ${message}`);
  }
}

async function handleGetEmbeddingConfig() {
  return getEmbeddingConfigInfo();
}

async function handleSetEmbeddingConfig({ body }: RouteHandlerArgs) {
  if (!body || typeof body !== "object") {
    throw new BadRequestError("Request body is required");
  }
  const { provider, model, baseUrl, dimensions } = body as {
    provider?: string;
    model?: string;
    baseUrl?: string;
    dimensions?: number | null;
  };
  if (!provider || typeof provider !== "string") {
    throw new BadRequestError("Missing required field: provider");
  }
  if (!validEmbeddingProviderSet.has(provider)) {
    throw new BadRequestError(
      `Invalid provider "${provider}". Valid providers: ${[...validEmbeddingProviderSet].join(", ")}`,
    );
  }
  if (model !== undefined && typeof model !== "string") {
    throw new BadRequestError("Field 'model' must be a string");
  }
  if (baseUrl !== undefined && typeof baseUrl !== "string") {
    throw new BadRequestError("Field 'baseUrl' must be a string");
  }
  if (
    typeof baseUrl === "string" &&
    baseUrl !== "" &&
    !resolveOpenAICompatibleBaseUrl(baseUrl)
  ) {
    throw new BadRequestError("Field 'baseUrl' must be an http(s) URL");
  }
  if (
    dimensions !== undefined &&
    dimensions !== null &&
    (typeof dimensions !== "number" ||
      !Number.isInteger(dimensions) ||
      dimensions <= 0)
  ) {
    throw new BadRequestError(
      "Field 'dimensions' must be a positive integer or null",
    );
  }
  try {
    return await setEmbeddingConfig(provider, model, getModelSetContext(), {
      baseUrl,
      dimensions,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new InternalError(`Failed to set embedding config: ${message}`);
  }
}

/**
 * The `config_set` body. `value` is `z.unknown()` — deliberately wider than
 * an object shape — because the CLI contract writes scalar values and
 * explicit `null`s (`set heartbeat.activeHoursStart null` clears a key), so
 * the value is any JSON at all; only its PRESENCE is required, which zod
 * cannot express on an unknown leaf, so the handler keeps that domain check.
 */
const ConfigSetByKeyBodySchema = z
  .object({
    path: z.string().min(1),
    value: z.unknown(),
  })
  .meta({ id: "ConfigSetByKeyRequest" });

/**
 * Wire shape of the `memory` section in config responses. Passthrough
 * preserves fields beyond `enabled` and `v2` so the client doesn't strip
 * unrecognised memory config that newer daemons may add.
 */
const MemoryWireConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    v2: z.object({ enabled: z.boolean().optional() }).passthrough().optional(),
  })
  .passthrough()
  .meta({ id: "MemoryConfig" });

/**
 * Given a `z.object(...)` schema, returns a new schema where every property
 * is `.nullable().optional()`. Used to express PATCH body semantics where any
 * field can be `null` (meaning "delete via deep-merge") or omitted (unchanged).
 */
function nullablePartial(schema: z.ZodObject<z.ZodRawShape>) {
  const shape: Record<string, z.ZodType> = {};
  for (const [key, value] of Object.entries(schema.shape)) {
    shape[key] = (value as z.ZodType).nullable().optional();
  }
  return z.object(shape);
}

/**
 * A single profile entry within a PATCH body. All fields are
 * `.nullable().optional()`: `null` = delete via deep-merge, omitted =
 * unchanged. Named so HeyAPI generates `ProfilePatchEntry` as a top-level
 * export in the SDK.
 */
const ProfilePatchEntrySchema = nullablePartial(ProfileEntry)
  .passthrough()
  .meta({ id: "ProfilePatchEntry" });

/**
 * A single call-site override within a PATCH body.
 */
const CallSiteOverrideDraftSchema = nullablePartial(
  LLMConfigFragment.extend({ profile: z.string().optional() }),
)
  .passthrough()
  .meta({ id: "CallSiteOverrideDraft" });

/**
 * Request body schema for `PATCH /v1/config`.
 *
 * Mirrors the response shape but every field is `.nullable().optional()`:
 * omitted keys are left unchanged by the daemon's deep-merge, `null` values
 * delete the key. Uses the same Zod enums as `AssistantConfigSchema` so
 * the generated SDK produces literal-union types — no hand-written patch
 * types needed downstream.
 */
export type ConfigPatchRequest = z.infer<typeof ConfigPatchRequestSchema>;

export const ConfigPatchRequestSchema = z
  .object({
    ...ChatSettingsPatchSchema.shape,
    llm: z
      .object({
        default: nullablePartial(LLMDefaultConfigSchema)
          .passthrough()
          .nullable()
          .optional(),
        profiles: z
          .record(z.string(), ProfilePatchEntrySchema.nullable())
          .nullable()
          .optional(),
        profileOrder: z.array(z.string().min(1)).optional(),
        activeProfile: z.string().min(1).nullable().optional(),
        advisorProfile: z.string().min(1).nullable().optional(),
        callSites: z
          .record(z.string(), CallSiteOverrideDraftSchema.nullable())
          .optional(),
        profileSession: nullablePartial(LLMSchema.shape.profileSession.unwrap())
          .nullable()
          .optional(),
      })
      .passthrough()
      .optional(),
    memory: MemoryWireConfigSchema.nullable().optional(),
    services: z
      .object({
        "web-search": z
          .object({
            provider: z.string().optional(),
          })
          .passthrough()
          .nullable()
          .optional(),
        "web-fetch": z
          .object({
            provider: z.string().optional(),
          })
          .passthrough()
          .nullable()
          .optional(),
        "image-generation": z
          .object({
            provider: z.string().optional(),
            model: z.string().optional(),
          })
          .passthrough()
          .nullable()
          .optional(),
        inference: z
          .object({ mode: ServiceModeSchema.optional() })
          .passthrough()
          .nullable()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()
  .meta({ id: "ConfigPatchRequest" });

/**
 * The response contract for `GET`/`PATCH /v1/config` — the five subtrees
 * external clients actually read, picked out of the full graph. Rendering
 * the whole `AssistantConfigSchema` into the spec blasted openapi.yaml past
 * 12K lines; we're not ready to trim the response schema itself yet, so the
 * runtime still returns the full config and the spec documents these.
 */
const ConfigGetResponseSchema = AssistantConfigSchema.pick({
  conversations: true,
  notifications: true,
  llm: true,
  memory: true,
  services: true,
});

/**
 * Return the JSON Schema for the assistant config (full or scoped).
 *
 * The schema is derived from `AssistantConfigSchema` at runtime via
 * `z.toJSONSchema()`. Pure read; no daemon state involved.
 */
function handleGetConfigSchema({ queryParams = {} }: RouteHandlerArgs) {
  const rawPath = queryParams.path;
  const path = typeof rawPath === "string" ? rawPath.trim() : "";

  if (!path) {
    return {
      schema: z.toJSONSchema(AssistantConfigSchema, {
        unrepresentable: "any",
        io: "input",
      }),
    };
  }

  const subSchema = getSchemaAtPath(AssistantConfigSchema, path);
  if (!subSchema) {
    throw new BadRequestError(`No schema found at path: ${path}`);
  }

  return {
    schema: z.toJSONSchema(subSchema, {
      unrepresentable: "any",
      io: "input",
    }),
  };
}

/**
 * Reject incomplete routing-identity profiles and unroutable explicit models.
 * The partial llm.default base may omit a model. saveRawConfig
 * persists without schema validation, so the parse-time rejection alone
 * would let the pair reach disk and be stripped on the next read — a silent
 * no-op where the user expects a saved override.
 */
function collectProviderEntries(
  raw: Record<string, unknown>,
): [string, { provider?: unknown; model?: unknown }][] {
  const llm = raw.llm as
    | {
        default?: { provider?: unknown; model?: unknown } | null;
        profiles?: Record<
          string,
          { provider?: unknown; model?: unknown } | null | undefined
        >;
        callSites?: Record<
          string,
          { provider?: unknown; model?: unknown } | null | undefined
        >;
      }
    | undefined;
  const entries: [string, { provider?: unknown; model?: unknown }][] = [];
  // llm.default is a partial base fragment carrying the provider selection.
  // Validate an explicitly supplied model, but do not require one.
  if (llm?.default) {
    entries.push(["llm.default", llm.default]);
  }
  for (const section of ["profiles", "callSites"] as const) {
    for (const [name, entry] of Object.entries(llm?.[section] ?? {})) {
      if (entry) {
        entries.push([`llm.${section}.${name}`, entry]);
      }
    }
  }
  return entries;
}

function assertRoutableIdentityEntries(
  preWrite: Record<string, unknown>,
  raw: Record<string, unknown>,
): void {
  const entries = collectProviderEntries(raw);
  const priorProviders = new Map(
    collectProviderEntries(preWrite).flatMap(([label, entry]) =>
      typeof entry.provider === "string" ? [[label, entry.provider]] : [],
    ),
  );
  for (const [label, entry] of entries) {
    if (typeof entry.provider !== "string") {
      continue;
    }
    // The provider schema is an open string (a stored value outside the
    // known set parses instead of stripping its profile), so write-time
    // membership is enforced here and at the profiles route. Scoped to
    // providers this write introduces or changes: a stored value outside
    // the known set is readable and dispatchable by design, and
    // re-validating it on every write would make all later settings saves
    // fail with no in-product repair path. Profiles accept entry names;
    // call-site fragments and the legacy default blob stay vendor-only
    // (overrides become model-only with the entries demolition).
    if (entry.provider !== priorProviders.get(label)) {
      const providerIssue = label.startsWith("llm.profiles.")
        ? writableProfileProviderIssue(entry.provider)
        : unknownLlmProviderIssue(entry.provider);
      if (providerIssue) {
        throw new BadRequestError(`${providerIssue} (${label})`);
      }
    }
    // A model-less entry under a code-defined default name is the thin
    // managed stub — its content is code-owned, so the routing-identity
    // model check applies only to entries carrying their own body.
    const profileName = label.startsWith("llm.profiles.")
      ? label.slice("llm.profiles.".length)
      : undefined;
    const isManagedName =
      profileName != null && MANAGED_PROFILE_NAMES.has(profileName);
    if (entry.model == null && isManagedName) {
      continue;
    }
    if (label === "llm.default" && entry.model == null) {
      continue;
    }
    const issue = routingIdentityModelIssue(
      entry.provider,
      typeof entry.model === "string" ? entry.model : undefined,
    );
    if (issue) {
      throw new BadRequestError(`${issue} (${label})`);
    }
  }
}

export async function commitConfigWrite(
  raw: Record<string, unknown>,
  opLabel: string,
): Promise<void> {
  // `loadRawConfig()` reads fresh from disk and the save hasn't happened yet,
  // so it is the pre-write state; raw-to-raw comparison avoids parsed-vs-raw
  // false diffs. Runs before the watcher-suppress/save sequence so a
  // rejection needs no suppress-flag or cache cleanup.
  const preWrite = loadRawConfig();
  // Direct callers (the profile routes) skip `handleSetConfig`'s full-schema
  // parse — this keeps a chat-settings write's invalid values from reaching
  // disk, while untouched legacy values ride (their issues filter out).
  const chatSettings = validateChatSettingsWrite(preWrite, raw);
  if (!chatSettings.success) {
    throw new BadRequestError(chatSettings.error.message);
  }
  assertRoutableIdentityEntries(preWrite, raw);

  // Suppress the file-watcher callback for the duration of the debounce
  // window. Without this, the ConfigWatcher detects the config.json write
  // ~200ms later, sees a stale fingerprint, and calls initializeProviders a
  // second time - starting with providers.clear() which races with the
  // explicit reinit below. The watcher also fires onConversationEvict(),
  // which would evict all cached conversations on every write. Mirror the
  // suppress/reset pattern used in setImageGenModel (config-model.ts).
  const configWatcher = getConfigWatcher();
  const wasSuppressed = configWatcher.suppressConfigReload;
  configWatcher.suppressConfigReload = true;
  try {
    saveRawConfig(raw);
  } catch (err) {
    configWatcher.suppressConfigReload = wasSuppressed;
    const message = err instanceof Error ? err.message : String(err);
    throw new InternalError(`Failed to ${opLabel} config: ${message}`);
  }
  configWatcher.timers.schedule(
    "__suppress_reset__",
    () => {
      configWatcher.suppressConfigReload = false;
    },
    CONFIG_RELOAD_DEBOUNCE_MS,
  );

  clearEmbeddingBackendCache();
  invalidateConfigCache();
  rescheduleHeartbeatIfTimezoneChanged(preWrite, raw);
  // Reinitialize providers so the live registry reflects the new config.
  // Suppress disk writes inside getConfig() — we just wrote the raw config
  // and the first-launch seed path would overwrite it with full defaults.
  try {
    await withSuppressedConfigDiskWrites(async () => {
      await initializeProviders(getConfig());
      configWatcher.updateFingerprint();
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, `${opLabel} config: provider reinit failed: ${message}`);
  }

  // Notify clients. The file watcher normally publishes this, but it is
  // suppressed for the whole debounce window above, so a route-driven write
  // (profile create, active-profile switch, config patch) would otherwise
  // leave every other client rendering stale config until a manual refresh —
  // e.g. the chat composer still showing the previous model profile.
  publishConfigChanged();
}

async function handlePatchConfig({ body }: RouteHandlerArgs) {
  // First-class body parse — the same schema the route spec declares — so a
  // malformed subtree is rejected with path-qualified messages before any
  // guard or merge runs.
  const patch = ConfigPatchRequestSchema.safeParse(body);
  if (!patch.success) {
    throw new BadRequestError(
      patch.error.issues
        .map((issue) =>
          issue.path.length > 0
            ? `${issue.path.join(".")}: ${issue.message}`
            : issue.message,
        )
        .join("; "),
    );
  }
  if (Object.keys(patch.data).length === 0) {
    throw new BadRequestError("Body must be a non-empty JSON object");
  }
  // A patch is partial: merge it onto the current config so the schema
  // parse in `handleSetConfig` always sees a complete config — untouched
  // values ride, sparse fragments are completed by the merge base.
  const merged: AssistantConfig = structuredClone(getConfig());
  const ingress = z
    .object({ publicBaseUrl: z.unknown().optional() })
    .passthrough()
    .safeParse(patch.data.ingress);
  const patchedIngressUrl = ingress.success
    ? ingress.data.publicBaseUrl
    : undefined;
  if (patchedIngressUrl !== undefined) {
    dropTunnelRecordsForNewUrl(merged.ingress, patchedIngressUrl);
  }
  deepMergeOverwrite(merged, patch.data);
  scrubNulledAcpAgentLeaves(merged);
  scrubNulledChatSettings(merged, patch.data);

  await handleSetConfig(merged);

  return getConfig();
}

/**
 * The one config write: validate the merged config through
 * `AssistantConfigSchema`, and either reject with `BadRequestError` or save.
 * `handlePatchConfig` merges the patch with `getConfig()` first;
 * `handleSetConfigByKey` replaces one path first. Everything the schema
 * accepts is what lands on disk.
 */
async function handleSetConfig(merged: AssistantConfig): Promise<void> {
  const parsed = AssistantConfigSchema.safeParse(merged);
  if (!parsed.success) {
    throw new BadRequestError(
      parsed.error.issues
        .map((issue) =>
          issue.path.length > 0
            ? `${issue.path.join(".")}: ${issue.message}`
            : issue.message,
        )
        .join("; "),
    );
  }
  await commitConfigWrite(parsed.data, "save");
}

/**
 * Direct path assignment - the `assistant config set <key> <value>` CLI
 * contract.
 *
 * `config_patch` uses `deepMergeOverwrite` semantics, which strips `null`
 * leaves when the target subtree doesn't exist and merges (rather than
 * replaces) object subtrees. That's correct for partial updates (embedding
 * config, profile patches) but breaks single-key `set` semantics, where the
 * user expects:
 *   - `set heartbeat.activeHoursStart null` to persist explicit `null`
 *   - `set llm {}` to replace `llm`, not merge into it
 *
 * `config_set` performs `setNestedValue` directly on the current config
 * (no merge), then funnels into the same schema-validated
 * {@link handleSetConfig} write.
 */
async function handleSetConfigByKey({ body }: RouteHandlerArgs) {
  const parsedBody = ConfigSetByKeyBodySchema.safeParse(body);
  if (!parsedBody.success) {
    throw new BadRequestError(
      "Body must be a JSON object with `path` and `value`",
    );
  }
  const path = parsedBody.data.path;
  // `value` must be present (use explicit `null` to clear a key). Without
  // this check, `undefined` flows into `setNestedValue` and gets dropped by
  // `JSON.stringify` at save time, silently removing the key - which is
  // distinct from the documented "set to null" semantics. zod cannot express
  // "any value, but the key must exist", so this stays a domain check.
  if (!Object.hasOwn(parsedBody.data, "value")) {
    throw new BadRequestError(
      "`value` is required (use `null` to clear a key)",
    );
  }
  const value = parsedBody.data.value;

  const merged: AssistantConfig = structuredClone(getConfig());
  // `assistant config set ingress.publicBaseUrl <url>`, what the webhook
  // diagnostics tell users to run, retargets ingress like the settings route.
  if (path === "ingress.publicBaseUrl") {
    dropTunnelRecordsForNewUrl(merged.ingress, value);
  }
  setNestedValue(merged, path, value);
  scrubNulledAcpAgentLeaves(merged);

  await handleSetConfig(merged);

  // A `memory.v2` substrate tunable whose `memory.substrate` twin is set does
  // not mean what an unpaired write means: the substrate namespace wins in
  // `resolveSubstrateTuning`, and for the three twins the v2 injection engine
  // reads directly the two namespaces diverge instead. Report which case this
  // is alongside the success so the caller can tell the operator.
  const shadowing = findSubstrateShadowing(path);
  if (shadowing) {
    const warning = describeShadowedConfigSet(shadowing, path);
    log.warn({ path, substratePath: shadowing.substratePath }, warning);
    return { ok: true, warning };
  }
  return { ok: true };
}

/**
 * Validate the regex patterns inside the workspace's
 * `secret-allowlist.json` file.
 *
 * Pure read: opens the file, attempts to compile each pattern, returns
 * structured errors. The handler returns `{ exists: false }` if the file is
 * absent, or `{ exists: true, errors: [...] }` otherwise.
 */
function handleValidateAllowlist() {
  try {
    const errors = validateAllowlistFile();
    if (errors == null) {
      return { exists: false } as const;
    }
    return { exists: true, errors } as const;
  } catch (err) {
    // `validateAllowlistFile` does a raw `JSON.parse` on
    // `secret-allowlist.json` and can throw on malformed JSON. Surface
    // that as a structured `parseError` in the response payload instead
    // of letting it propagate as a 500. Preserves the pre-IPC CLI
    // behavior, which printed a user-readable failure and exited 1.
    const message = err instanceof Error ? err.message : String(err);
    return { exists: true, parseError: message, errors: [] } as const;
  }
}

async function handleReplaceInferenceProfile({
  pathParams = {},
  body,
}: RouteHandlerArgs) {
  const name = (pathParams.name ?? "").trim();
  if (!name) {
    throw new BadRequestError("Profile name must be a non-empty string");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new BadRequestError("Body must be a JSON object");
  }
  if (RESERVED_PROFILE_NAMES.has(name)) {
    throw new BadRequestError(
      `Profile name "${name}" is reserved and cannot be used.`,
    );
  }
  const parsed = ProfileEntry.safeParse(body);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => issue.message).join("; ");
    throw new BadRequestError(`Invalid profile fragment: ${detail}`);
  }
  // A managed name with no existing entry stays protected so users can't
  // shadow a seeded cloud profile. An existing entry on a non-`cadet`
  // provider is user-owned and remains fully editable.
  const existingProfile = asMutablePlainObject(
    getConfig().llm.profiles?.[name],
  );
  const isCloud =
    MANAGED_PROFILE_NAMES.has(name) &&
    (existingProfile == null || existingProfile.provider === "cadet");
  if (CODE_OWNED_PROFILE_NAMES.has(name)) {
    // A code-owned profile resolves from the catalog whatever the workspace
    // holds, so even a status re-enable would persist a stub that never
    // governs anything. Reject the write rather than accept a silent no-op.
    // Checked ahead of the availability gate below so the code-owned backups,
    // which are always available yet are not `DEFAULT_PROFILE_KEYS` members,
    // report why the write is refused rather than claiming they do not exist.
    throw new BadRequestError(
      `Profile "${name}" is code-owned and cannot be edited. ` +
        `Duplicate it to a custom profile to customize.`,
    );
  }
  // A flag-gated managed name (`os-beta`) with no materialized entry cannot
  // be patched: it only resolves while the flag reconcile has created its
  // stub, so writing status here would persist an entry that fights the
  // reconcile. The always-available defaults are catalog-owned even when
  // absent — a status re-enable on them just creates the thin stub.
  if (
    MANAGED_PROFILE_NAMES.has(name) &&
    existingProfile == null &&
    !(DEFAULT_PROFILE_KEYS as readonly string[]).includes(name)
  ) {
    throw new BadRequestError(
      `Profile "${name}" is not currently available and cannot be edited.`,
    );
  }
  if (isCloud) {
    // Cloud profiles are daemon-seeded and read-only — enforce the contract
    // up front: the only body a cloud PUT accepts
    // front: the only body a cloud PUT accepts is a pure status re-enable
    // (`{status: "active"}`, or `{status: null}` to clear back to
    // active-by-absence). Rejecting here keeps the error message ahead of
    // any side effects and mirrors the guard's wording.
    const requestedKeys = Object.keys(parsed.data);
    const isStatusReenable =
      requestedKeys.length === 1 &&
      requestedKeys[0] === "status" &&
      (parsed.data.status === "active" || parsed.data.status === null);
    if (!isStatusReenable) {
      const disallowed = requestedKeys.filter((k) => k !== "status");
      const detail =
        disallowed.length > 0 ? ` fields [${disallowed.join(", ")}]` : "";
      throw new BadRequestError(
        `Cannot edit cloud profile "${name}"${detail}. ` +
          `Cloud profiles are read-only (a disabled profile can be re-enabled); ` +
          `duplicate to a custom profile to customize.`,
      );
    }
  }
  // Mix profiles reference other profiles by name. `ProfileEntry.safeParse`
  // above validates the fragment in isolation, so the cross-profile integrity
  // rules `LLMSchema.superRefine` enforces on full-config load (every arm
  // exists, no nesting, no self-reference, no config fields) must be checked
  // here against the live profile set — otherwise an invalid mix would persist
  // and break the next full config reparse.
  if (parsed.data.mix != null) {
    const MIX_ALLOWED_KEYS = new Set(["mix", "label", "description", "status"]);
    const extraneous = Object.keys(parsed.data).filter(
      (k) => !MIX_ALLOWED_KEYS.has(k),
    );
    if (extraneous.length > 0) {
      throw new BadRequestError(
        `Mix profile "${name}" cannot also set [${extraneous.join(", ")}] — a mix only references other profiles plus metadata (label, description, status).`,
      );
    }
    // Validate arms against the effective view (matches the resolver and
    // `LLMSchema.superRefine`), not the raw workspace record.
    const { llm: parsedLlm } = getConfig();
    const existingProfiles = getEffectiveProfilesForProvider(parsedLlm);
    parsed.data.mix.forEach((arm, index) => {
      if (arm.profile === name) {
        throw new BadRequestError(
          `Mix profile "${name}" cannot reference itself (arm ${index}).`,
        );
      }
      const target = existingProfiles[arm.profile];
      if (target == null) {
        throw new BadRequestError(
          `Mix profile "${name}" references profile "${arm.profile}" which is not defined.`,
        );
      }
      if (target.mix != null) {
        throw new BadRequestError(
          `Mix profile "${name}" references another mix profile "${arm.profile}" — mixes cannot be nested; constituents must be standard profiles.`,
        );
      }
    });
    // A fallback target must stay a standard profile: converting one to a
    // mix would leave another profile's fallbackProfile pointing at a mix,
    // which `LLMSchema.superRefine` rejects on the next full reparse.
    for (const [otherName, other] of Object.entries(existingProfiles)) {
      if (otherName !== name && other?.fallbackProfile === name) {
        throw new BadRequestError(
          `Profile "${otherName}" declares profile "${name}" as its fallbackProfile; a fallback must be a standard profile, so "${name}" cannot become a mix.`,
        );
      }
    }
  }

  // `fallbackProfile` references another profile by name. As with `mix`, the
  // cross-profile integrity rules `LLMSchema.superRefine` enforces on
  // full-config load (target exists, no self-reference, target is not a mix,
  // single hop) must be checked here against the live profile set; otherwise
  // a dangling or chained pointer would persist and break the next full
  // config reparse.
  if (parsed.data.fallbackProfile != null) {
    const fallback = parsed.data.fallbackProfile;
    if (fallback === name) {
      throw new BadRequestError(
        `Profile "${name}" cannot declare itself as its fallbackProfile.`,
      );
    }
    const { llm: parsedLlm } = getConfig();
    const existingProfiles = getEffectiveProfilesForProvider(parsedLlm);
    const target = existingProfiles[fallback];
    if (target == null) {
      throw new BadRequestError(
        `Profile "${name}" declares fallbackProfile "${fallback}" which is not defined.`,
      );
    }
    if (target.mix != null) {
      throw new BadRequestError(
        `Profile "${name}" declares fallbackProfile "${fallback}" which is a mix profile; a fallback must be a standard profile.`,
      );
    }
    if (target.fallbackProfile != null) {
      throw new BadRequestError(
        `Profile "${name}" declares fallbackProfile "${fallback}" which sets its own fallbackProfile; fallback is a single hop, chains are not allowed.`,
      );
    }
    for (const [otherName, other] of Object.entries(existingProfiles)) {
      if (otherName !== name && other?.fallbackProfile === name) {
        throw new BadRequestError(
          `Profile "${otherName}" already declares profile "${name}" as its fallbackProfile; fallback is a single hop, chains are not allowed.`,
        );
      }
    }
  }

  // When the UI sends provider but no provider_connection, derive the connection
  // now so the config deep-merge doesn't inherit a stale connection from the
  // default layer. Managed entries are excluded: the cloud gate above
  // already rejected any provider-carrying fragment, so their only surviving
  // body is a status re-enable, which derives no connection. A user-owned
  // profile sharing a cloud name is fully editable, so it takes the
  // derivation like any other custom profile.
  const fragment = parsed.data as Record<string, unknown>;
  // Routing identities resolve their connection per-request from the
  // provider value; deriving one here would stamp the canonical cadet row
  // ("cadet" is its stored provider) or create a junk "<identity>-personal"
  // connection for chatgpt.
  if (
    !isCloud &&
    fragment.provider &&
    !fragment.provider_connection &&
    !ROUTING_IDENTITY_PROVIDERS.has(fragment.provider as string)
  ) {
    const provider = fragment.provider as string;
    const db = getDb();
    // Exclude the orphaned legacy `*-managed` rows: they may still linger in
    // provider_connections on upgraded workspaces (hidden from the list route
    // until a follow-up migration deletes them). Auto-binding to one would keep
    // the profile stale and break it once those rows are removed.
    const [active] = listConnections(db, { provider }).filter(
      (c) => !LEGACY_MANAGED_CONNECTION_NAMES.has(c.name),
    );
    if (active) {
      fragment.provider_connection = active.name;
    } else if (
      CLOUD_ROUTABLE_PROVIDERS.has(provider) &&
      getConnection(db, CADET_CLOUD_CONNECTION_NAME)
    ) {
      // Managed-routable providers are served by the single Cadet Cloud
      // connection; prefer it over lazily creating a personal connection.
      fragment.provider_connection = CADET_CLOUD_CONNECTION_NAME;
    } else if (!PROVIDERS_REQUIRING_BASE_URL_AND_MODELS.has(provider)) {
      const connectionName = `${provider}-personal`;
      const isKeyless = provider === "ollama";
      const result = createConnection(db, {
        name: connectionName,
        provider,
        auth: isKeyless
          ? { type: "none" }
          : {
              type: "api_key",
              credential: credentialKey(provider, "api_key"),
            },
      });
      if (result.ok) {
        fragment.provider_connection = connectionName;
      }
    }
  }

  const raw = loadRawConfig();
  if (isCloud) {
    // Partial overlay: keep every existing key intact, only apply the status
    // re-enable (the sole body the cloud gate above admits). Using
    // `replaceInferenceProfileConfig` here would wipe the seed-owned fields
    // (provider, model, advanced params) because that function assumes the
    // body carries the full UI surface.
    applyCloudProfileReenable(raw, name, fragment.status as "active" | null);
  } else {
    replaceInferenceProfileConfig(raw, name, fragment);
  }
  // Route through `commitConfigWrite` so profile edits flow through the
  // post-write side effects shared with `handlePatchConfig` /
  // `handleSetConfig`: file-watcher suppression so the in-process reload
  // doesn't race the explicit reinit, embedding backend cache clear,
  // in-process `getConfig` cache invalidation, and provider registry
  // reinitialization. `status: "disabled"` on a cloud profile (and any
  // `provider` / `model` / `provider_connection` change on a custom
  // profile) must take effect immediately rather than waiting for the
  // next watcher tick.
  await commitConfigWrite(raw, "replace inference profile");
  return { ok: true };
}

/**
 * Apply the disabled→active re-enable to a cloud profile entry, preserving
 * every other field already on disk (provider, model, advanced params, etc).
 * `status: "active"` sets the key; `null` clears it (active-by-absence).
 */
function applyCloudProfileReenable(
  raw: Record<string, unknown>,
  name: string,
  status: "active" | null,
): void {
  const existingLlm = asMutablePlainObject(raw.llm);
  const llm = existingLlm ?? {};
  if (!existingLlm) {
    raw.llm = llm;
  }

  const existingProfiles = asMutablePlainObject(llm.profiles);
  const profiles = existingProfiles ?? {};
  if (!existingProfiles) {
    llm.profiles = profiles;
  }

  const nextProfile: Record<string, unknown> = {
    ...(asMutablePlainObject(profiles[name]) ?? {}),
  };
  if (status === null) {
    delete nextProfile.status;
  } else {
    nextProfile.status = status;
  }
  profiles[name] = nextProfile;
}

async function handleSearchConversations({
  queryParams = {},
}: RouteHandlerArgs) {
  const q = queryParams.q;
  if (!q) {
    throw new BadRequestError("Missing required query parameter: q");
  }
  const limit = queryParams.limit ? Number(queryParams.limit) : undefined;
  const maxMessages = queryParams.maxMessagesPerConversation
    ? Number(queryParams.maxMessagesPerConversation)
    : undefined;
  const results = await performConversationSearch({
    query: q,
    limit,
    maxMessagesPerConversation: maxMessages,
    // Under `sidebar-done` a done chat is filed rather than hidden, so the
    // agent's own history search reaches it the same way the user's does.
    includeArchived: isSidebarDoneEnabled(),
  });
  return { query: q, results };
}

function handleGetMessageContent({
  queryParams = {},
  pathParams = {},
}: RouteHandlerArgs) {
  const conversationId = queryParams.conversationId;
  const result = getMessageContent(
    pathParams.id ?? "",
    conversationId ?? undefined,
  );
  if (!result) {
    throw new NotFoundError(`Message ${pathParams.id} not found`);
  }
  return result;
}

async function handleGetLlmContext({
  pathParams = {},
  queryParams = {},
}: RouteHandlerArgs) {
  assertLlmRequestLoggingEnabled();
  const messageId = pathParams.id;
  if (!messageId) {
    throw new BadRequestError("message id is required");
  }
  const view = resolveLlmContextView(queryParams.view);
  const source = await getLlmRequestLogSource();
  const logs = await source.getRequestLogsByMessageId(messageId);
  const turnMessageIds = getAssistantMessageIdsInTurn(messageId);
  const memoryRecallLog = getMemoryRecallLogByMessageIds(turnMessageIds);
  const memoryV2Activation =
    getMemoryV2ActivationLogByMessageIds(turnMessageIds);
  const message = getMessageById(messageId);
  const conversation = message ? getConversation(message.conversationId) : null;
  const conversationKind: ConversationKind = conversation
    ? resolveConversationKind(
        conversation.source,
        conversation.conversationType,
      )
    : "user";
  // Running total of estimated USD cost across every priced LLM call in
  // the conversation. Maintained by `updateConversationUsage` whenever a
  // turn finishes — see `assistant/src/memory/conversation-crud.ts`.
  const conversationTotalEstimatedCostUsd =
    conversation?.totalEstimatedCost ?? null;
  // v3 selections are keyed to the turn's message ids (stamped by the turn-end
  // backfill), independent of v2's tracker turn — so the panel shows whenever
  // the turn has v3 data, regardless of v2/v3 turn-counter drift.
  const memoryV3Selection =
    await getMemoryV3SelectionForInspectorByMessageIds(turnMessageIds);
  return {
    messageId,
    conversationKind,
    conversationTotalEstimatedCostUsd,
    logs: logs.map((log) => normalizeLlmContextLog(log, view)),
    memoryRecall: memoryRecallLog ?? null,
    memoryV2Activation: memoryV2Activation ?? null,
    memoryV3Selection,
  };
}

async function handleGetConversationLlmContext({
  queryParams = {},
}: RouteHandlerArgs) {
  assertLlmRequestLoggingEnabled();
  const conversationKey = queryParams.conversationKey;
  const requestedConversationId = queryParams.conversationId;
  const view = resolveLlmContextView(queryParams.view);

  let conversationId: string | undefined = requestedConversationId;
  if (!conversationId && conversationKey) {
    const mapping = getConversationByKey(conversationKey);
    conversationId = mapping?.conversationId;
  }

  if (!conversationId) {
    if (conversationKey) {
      return {
        conversationKey,
        conversationId: null,
        conversationKind: "user",
        conversationTotalEstimatedCostUsd: null,
        logs: [],
        memoryRecall: null,
        memoryV2Activation: null,
        memoryV3Selection: null,
      };
    }
    throw new BadRequestError(
      "conversationKey or conversationId query parameter is required",
    );
  }

  const conversation = getConversation(conversationId);
  if (!conversation) {
    if (conversationKey) {
      return {
        conversationKey,
        conversationId,
        conversationKind: "user",
        conversationTotalEstimatedCostUsd: null,
        logs: [],
        memoryRecall: null,
        memoryV2Activation: null,
        memoryV3Selection: null,
      };
    }
    throw new NotFoundError(`Conversation ${conversationId} not found`);
  }

  const source = await getLlmRequestLogSource();
  const logs = await source.getRequestLogsByConversationId(conversation.id);
  const conversationKind = resolveConversationKind(
    conversation.source,
    conversation.conversationType,
  );
  const conversationTotalEstimatedCostUsd =
    conversation.totalEstimatedCost ?? null;

  return {
    conversationKey: conversationKey ?? null,
    conversationId: conversation.id,
    conversationKind,
    conversationTotalEstimatedCostUsd,
    logs: logs.map((log) => normalizeLlmContextLog(log, view)),
    memoryRecall: null,
    memoryV2Activation: null,
    memoryV3Selection: null,
  };
}

async function handleGetLlmRequestLogPayload({
  pathParams = {},
}: RouteHandlerArgs) {
  assertLlmRequestLoggingEnabled();
  const logId = pathParams.id;
  if (!logId) {
    throw new BadRequestError("log id is required");
  }
  const source = await getLlmRequestLogSource();
  const log = await source.getRequestLogById(logId);
  if (!log) {
    throw new NotFoundError("log not found");
  }
  let requestPayload: unknown;
  try {
    requestPayload = JSON.parse(log.requestPayload);
  } catch {
    requestPayload = log.requestPayload;
  }
  let responsePayload: unknown;
  try {
    responsePayload = JSON.parse(log.responsePayload);
  } catch {
    responsePayload = log.responsePayload;
  }
  return { id: log.id, requestPayload, responsePayload };
}

async function handleGetLlmRequestLogContext({
  pathParams = {},
}: RouteHandlerArgs) {
  assertLlmRequestLoggingEnabled();
  const logId = pathParams.id;
  if (!logId) {
    throw new BadRequestError("log id is required");
  }
  const source = await getLlmRequestLogSource();
  const log = await source.getRequestLogById(logId);
  if (!log) {
    throw new NotFoundError("log not found");
  }
  return normalizeLlmContextLog(log);
}

function resolveQueuedMessageConversationId({
  queryParams = {},
  body,
  headers = {},
}: RouteHandlerArgs): string | undefined {
  const bodyConversationId = body?.conversationId;
  const conversationId =
    queryParams.conversationId ??
    (typeof bodyConversationId === "string" ? bodyConversationId : undefined) ??
    headers["x-cadet-conversation-id"];
  return typeof conversationId === "string" && conversationId.length > 0
    ? conversationId
    : undefined;
}

async function handleDeleteQueuedMessage(args: RouteHandlerArgs) {
  const { pathParams = {}, headers = {} } = args;
  const conversationId = resolveQueuedMessageConversationId(args);
  if (!conversationId) {
    throw new BadRequestError("Missing required parameter: conversationId");
  }
  // Verified caller identity. Both adapters derive this header from the auth
  // context, never from a caller-supplied one. Normalize it exactly as the
  // send path does before comparing against the principal recorded at
  // enqueue, or the two disagree: `resolveActorPrincipalIdForLocalGuardian`
  // translates the synthetic `dev-bypass` principal to the real local
  // guardian under `DISABLE_HTTP_AUTH=true` (a no-op for real JWT
  // principals), and every sibling handler in this layer trims first.
  const actorPrincipalId = await resolveActorPrincipalIdForLocalGuardian(
    headers["x-cadet-actor-principal-id"]?.trim() || undefined,
  );
  const result = deleteQueuedMessage(conversationId, pathParams.id ?? "", {
    actorPrincipalId,
  });
  if (result.removed) {
    return { ok: true, conversationId, requestId: pathParams.id };
  }
  if (result.reason === "conversation_not_found") {
    throw new NotFoundError("Conversation not found");
  }
  if (result.reason === "forbidden") {
    throw new ForbiddenError(
      "Queued message was sent by a different user and cannot be cancelled here",
    );
  }
  throw new NotFoundError("Queued message not found");
}

async function handleSteerToMessage(args: RouteHandlerArgs) {
  const { pathParams = {}, headers = {} } = args;
  const conversationId = resolveQueuedMessageConversationId(args);
  if (!conversationId) {
    throw new BadRequestError("Missing required parameter: conversationId");
  }
  // Verified caller identity, normalized exactly as the delete path above
  // (see the comment in `handleDeleteQueuedMessage`).
  const actorPrincipalId = await resolveActorPrincipalIdForLocalGuardian(
    headers["x-cadet-actor-principal-id"]?.trim() || undefined,
  );
  const result = steerToMessage(conversationId, pathParams.id ?? "", {
    actorPrincipalId,
  });
  if (result.steered) {
    return { ok: true, conversationId, requestId: pathParams.id };
  }
  if (result.reason === "conversation_not_found") {
    throw new NotFoundError("Conversation not found");
  }
  if (result.reason === "not_processing") {
    throw new BadRequestError(
      "Cannot steer: conversation is not currently processing",
    );
  }
  if (result.reason === "forbidden") {
    throw new ForbiddenError(
      "Queued message was sent by a different user and cannot be steered to here",
    );
  }
  throw new NotFoundError("Queued message not found");
}

// ---------------------------------------------------------------------------
// Route definitions (shared HTTP + IPC)
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "model_get",
    endpoint: "model",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get current model config",
    description:
      "Return the active LLM model ID, provider, and available models.",
    tags: ["config"],
    handler: handleGetModel,
  },
  {
    operationId: "model_image_gen_set",
    endpoint: "model/image-gen",
    method: "PUT",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Set image generation model",
    description: "Change the active image generation model.",
    tags: ["config"],
    requestBody: z.object({ modelId: z.string() }),
    handler: handleSetImageGenModel,
  },
  {
    operationId: "config_embeddings_get",
    endpoint: "config/embeddings",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get embedding config",
    description:
      "Return the active embedding provider, model, and available options.",
    tags: ["config"],
    handler: handleGetEmbeddingConfig,
  },
  {
    operationId: "config_embeddings_set",
    endpoint: "config/embeddings",
    method: "PUT",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Set embedding config",
    description:
      "Change the embedding provider, model, and optional custom endpoint.",
    tags: ["config"],
    requestBody: z.object({
      provider: z.string(),
      model: z.string().optional(),
      baseUrl: z.string().optional(),
      dimensions: z.number().int().positive().nullable().optional(),
    }),
    handler: handleSetEmbeddingConfig,
  },
  {
    operationId: "config_get",
    endpoint: "config",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get full config",
    description: "Return the raw settings.json configuration object.",
    tags: ["config"],
    responseBody: ConfigGetResponseSchema,
    handler: getConfig,
  },
  {
    operationId: "config_patch",
    endpoint: "config",
    method: "PATCH",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Patch config",
    description:
      "Deep-merge a partial JSON object into the settings.json configuration.",
    tags: ["config"],
    requestBody: ConfigPatchRequestSchema,
    responseBody: ConfigGetResponseSchema,
    handler: handlePatchConfig,
  },
  {
    operationId: "config_set",
    endpoint: "config/set",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Set a single config path",
    description:
      "Assign a value at a dotted config path with direct-replacement semantics " +
      "(preserves explicit null, replaces object subtrees instead of merging). " +
      "Used by the `assistant config set <key> <value>` CLI command.",
    tags: ["config"],
    requestBody: ConfigSetByKeyBodySchema,
    handler: handleSetConfigByKey,
  },
  {
    operationId: "config_allowlist_validate",
    endpoint: "config/allowlist/validate",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Validate secret-allowlist.json regex patterns",
    description:
      "Compile each regex pattern in secret-allowlist.json and return any " +
      "syntax errors. Returns { exists: false } if no file is present.",
    tags: ["config"],
    handler: handleValidateAllowlist,
  },
  {
    operationId: "config_schema_get",
    endpoint: "config/schema",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get config JSON Schema",
    description:
      "Return the JSON Schema for the assistant config, optionally scoped to a dotted-path sub-schema (e.g. ?path=calls).",
    tags: ["config"],
    queryParams: [
      {
        name: "path",
        schema: { type: "string" },
        description: "Optional dotted path to a config sub-key",
      },
    ],
    handler: handleGetConfigSchema,
  },
  {
    operationId: "config_llm_profiles_replace",
    endpoint: "config/llm/profiles/:name",
    method: "PUT",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Replace an inference profile",
    description:
      "Replace the settings-UI-managed leaves of a single llm.profiles entry while preserving non-UI leaves.",
    tags: ["config"],
    requestBody: ProfileEntry,
    handler: handleReplaceInferenceProfile,
  },
  {
    operationId: "conversations_search",
    endpoint: "conversations/search",
    method: "GET",
    policy: {
      requiredScopes: ["chat.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Search conversations",
    description:
      "Full-text search across conversation titles and message content.",
    tags: ["conversations"],
    queryParams: [
      {
        name: "q",
        required: true,
        schema: { type: "string" },
        description: "Search query",
      },
      {
        name: "limit",
        schema: { type: "integer" },
        description: "Max results",
      },
      {
        name: "maxMessagesPerConversation",
        schema: { type: "integer" },
        description: "Max messages per conversation",
      },
    ],
    responseBody: z.object({
      query: z.string(),
      results: z.array(z.unknown()),
    }),
    handler: handleSearchConversations,
  },
  {
    operationId: "messages_content_get",
    endpoint: "messages/:id/content",
    method: "GET",
    policy: {
      requiredScopes: ["chat.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get message content",
    description: "Return the full content of a single message by ID.",
    tags: ["messages"],
    queryParams: [
      {
        name: "conversationId",
        schema: { type: "string" },
        description: "Optional conversation ID filter",
      },
    ],
    handler: handleGetMessageContent,
  },
  {
    operationId: "conversations_llm_context_get",
    endpoint: "conversations/llm-context",
    method: "GET",
    policy: {
      requiredScopes: ["chat.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get LLM context for a conversation",
    description:
      "Returns normalized LLM request/response logs for an entire conversation.",
    tags: ["conversations"],
    queryParams: [
      {
        name: "conversationKey",
        required: false,
        schema: { type: "string" },
        description: "Stable external conversation key.",
      },
      {
        name: "conversationId",
        required: false,
        schema: { type: "string" },
        description: "Internal conversation identifier.",
      },
      {
        name: "view",
        required: false,
        schema: { type: "string", enum: ["full", "summary"] },
        description:
          "Response shape. 'summary' omits per-log request/response sections; defaults to 'full'.",
      },
    ],
    responseBody: LlmContextResponseSchema,
    handler: handleGetConversationLlmContext,
  },
  {
    operationId: "messages_llm_context_get",
    endpoint: "messages/:id/llm-context",
    method: "GET",
    policy: {
      requiredScopes: ["chat.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get LLM context for a message",
    description:
      "Return request/response logs and memory recall data for a specific message.",
    tags: ["messages"],
    queryParams: [
      {
        name: "view",
        required: false,
        schema: { type: "string", enum: ["full", "summary"] },
        description:
          "Response shape. 'summary' omits per-log request/response sections; defaults to 'full'.",
      },
    ],
    responseBody: LlmContextResponseSchema,
    handler: handleGetLlmContext,
  },
  {
    operationId: "llm_request_logs_payload_get",
    endpoint: "llm-request-logs/:id/payload",
    method: "GET",
    policy: {
      requiredScopes: ["chat.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get raw payload for a single LLM request log",
    description:
      "Return the full request and response payloads for a specific log entry.",
    tags: ["messages"],
    responseBody: z.object({
      id: z.string(),
      requestPayload: z.unknown(),
      responsePayload: z.unknown(),
    }),
    handler: handleGetLlmRequestLogPayload,
  },
  {
    operationId: "llm_request_logs_context_get",
    endpoint: "llm-request-logs/:id/context",
    method: "GET",
    policy: {
      requiredScopes: ["chat.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Get normalized context for a single LLM request log",
    description:
      "Return the normalized summary and request/response sections for a specific log entry.",
    tags: ["messages"],
    responseBody: LLMRequestLogEntrySchema,
    handler: handleGetLlmRequestLogContext,
  },
  {
    operationId: "messages_queued_delete",
    endpoint: "messages/queued/:id",
    method: "DELETE",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Delete a queued message",
    description:
      "Remove a pending message from the conversation queue before it is processed. " +
      "Broadcasts `message_queued_deleted` so every client can close out the pending row.",
    tags: ["messages"],
    queryParams: [
      {
        name: "conversationId",
        schema: { type: "string" },
        required: true,
        description: "Conversation ID (required)",
      },
    ],
    additionalResponses: {
      "403": {
        description:
          "The queued message was enqueued by a different actor principal.",
      },
      "404": {
        description: "Conversation or queued message not found.",
      },
    },
    handler: handleDeleteQueuedMessage,
  },
  {
    operationId: "messages_queued_steer",
    endpoint: "messages/queued/:id/steer",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Steer to a queued message",
    description:
      "Promote a queued message to the head of the queue and abort the current generation so it is processed next.",
    tags: ["messages"],
    queryParams: [
      {
        name: "conversationId",
        schema: { type: "string" },
        required: true,
        description: "Conversation ID (required)",
      },
    ],
    additionalResponses: {
      "403": {
        description:
          "The queued message was enqueued by a different actor principal.",
      },
      "404": {
        description: "Conversation or queued message not found.",
      },
    },
    handler: handleSteerToMessage,
  },
];
