/**
 * Loader-coupled default-provider accessors. The pure read/resolution logic
 * lives in `default-provider-resolution.ts`; import from there in code that
 * already has a config in hand (route handlers especially) so the module
 * graph stays free of write-side loader exports.
 *
 * The selection persists inside the `llm.default` blob: `provider` names the
 * matrix column and `provider_connection` pins the connection. The blob is a
 * partial fragment (`LLMDefaultConfigSchema`) — these accessors manage only
 * the selection fields and leave the rest of the blob untouched.
 */
import { z } from "zod";

import { getDefaultProviderFromConfig } from "./default-provider-resolution.js";
import {
  getConfigReadOnly,
  invalidateConfigCache,
  loadRawConfig,
  saveRawConfig,
} from "./loader.js";
import {
  DEFAULT_PROVIDER_CHOICES,
  type DefaultProviderConfig,
  type LLMProvider,
} from "./schemas/llm.js";
import type { AssistantConfig } from "./types.js";

export { resolveDefaultConnectionName } from "./default-provider-resolution.js";

/**
 * The strict write-side wire contract for the default provider selection:
 * what the `config/llm/default-provider` PUT route accepts and what
 * `setDefaultProvider` persists into the blob. Kept separate from the stored
 * blob shape on purpose — the route rejects anything the matrix cannot
 * implement (a partial blob tolerates it and clamps at read), so a bogus
 * provider fails loudly here instead of silently resolving to the managed
 * column.
 */
export const DefaultProviderSelectionSchema = z.object({
  provider: z.enum(DEFAULT_PROVIDER_CHOICES as [LLMProvider, ...LLMProvider[]]),
  connectionName: z.string().min(1).optional(),
});

export function getDefaultProvider(
  config?: AssistantConfig,
): DefaultProviderConfig | null {
  return getDefaultProviderFromConfig(config ?? getConfigReadOnly());
}

export function setDefaultProvider(value: DefaultProviderConfig): void {
  const parsed = DefaultProviderSelectionSchema.parse(value);

  const config = loadRawConfig();
  if (config.llm == null || typeof config.llm !== "object") {
    config.llm = {};
  }
  const llm = config.llm as Record<string, unknown>;
  if (
    llm.default == null ||
    typeof llm.default !== "object" ||
    Array.isArray(llm.default)
  ) {
    llm.default = {};
  }
  const blob = llm.default as Record<string, unknown>;
  blob.provider = parsed.provider;
  if (parsed.connectionName != null) {
    blob.provider_connection = parsed.connectionName;
  } else {
    // The selection is replaced wholesale: no explicit pin means the stored
    // pin goes too, matching the connectionName-absent wire semantics.
    delete blob.provider_connection;
  }

  saveRawConfig(config);
  invalidateConfigCache();
}
