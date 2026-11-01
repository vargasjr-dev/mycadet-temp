/**
 * Loader-coupled default-provider write accessors. The pure connection-name
 * convention lives in `default-provider-resolution.ts`; import from there in
 * code that already has a config in hand (route handlers especially) so the
 * module graph stays free of write-side loader exports.
 *
 * The selection persists inside the `llm.default` blob: `provider` names the
 * matrix column and `provider_connection` pins the connection. The blob is a
 * partial fragment (`LLMDefaultConfigSchema`) — these accessors manage only
 * the selection fields and leave the rest of the blob untouched.
 */
import { z } from "zod";

import {
  invalidateConfigCache,
  loadRawConfig,
  saveRawConfig,
} from "./loader.js";
import {
  DEFAULT_PROVIDER_CHOICES,
  type DefaultProviderConfig,
  type LLMProvider,
} from "./schemas/llm.js";

/**
 * The blob as raw config carries it, for the re-save: only the selection
 * fields are typed, every other stored field passes through untouched.
 */
const StoredDefaultBlobSchema = z
  .looseObject({
    provider: z.string().min(1).optional(),
    provider_connection: z.string().min(1).optional(),
  })
  .catch({});

/**
 * The strict write-side wire contract for the default provider selection:
 * what the `config/llm/default-provider` PUT route accepts and what
 * `setDefaultProvider` persists into the blob. Kept separate from the stored
 * blob shape on purpose — the route rejects anything the matrix cannot
 * implement (a partial blob tolerates it and clamps at read), so a bogus
 * provider fails loudly here instead of silently resolving to the cloud
 * column.
 */
export const DefaultProviderSelectionSchema = z.object({
  provider: z.enum(DEFAULT_PROVIDER_CHOICES as [LLMProvider, ...LLMProvider[]]),
  connectionName: z.string().min(1).optional(),
});

export function setDefaultProvider(value: DefaultProviderConfig): void {
  const parsed = DefaultProviderSelectionSchema.parse(value);

  const config = loadRawConfig();
  // A missing or non-object `llm` reads as empty.
  const llm = z
    .looseObject({ default: StoredDefaultBlobSchema.optional() })
    .catch({})
    .parse(config.llm);
  const blob = { ...llm.default, provider: parsed.provider };
  if (parsed.connectionName != null) {
    blob.provider_connection = parsed.connectionName;
  } else {
    // The selection is replaced wholesale: no explicit pin means the stored
    // pin goes too, matching the connectionName-absent wire semantics.
    delete blob.provider_connection;
  }
  config.llm = { ...llm, default: blob };

  saveRawConfig(config);
  invalidateConfigCache();
}
