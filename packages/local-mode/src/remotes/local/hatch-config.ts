/**
 * Hatch-time config values and their delivery to the assistant.
 *
 * Hatch collects flat dot-notation key=value pairs (plus the onboarding
 * provider) and applies them through the assistant's public config API
 * (`POST /v1/config/set`) after the assistant is up — the same API the web
 * client and `assistant config set` use. There is no side channel: a remote
 * hatch and a local hatch speak the same route.
 */

/**
 * Convert flat dot-notation key=value pairs into a nested config object.
 *
 * e.g. {"llm.default.provider": "anthropic", "llm.default.model": "claude-opus-4-6"}
 *   → {llm: {default: {provider: "anthropic", model: "claude-opus-4-6"}}}
 */
export function buildNestedConfig(
  configValues: Record<string, string>,
): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const [dotKey, value] of Object.entries(configValues)) {
    const parts = dotKey.split(".");
    let target: Record<string, unknown> = config;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      const existing = target[part];
      if (
        existing == null ||
        typeof existing !== "object" ||
        Array.isArray(existing)
      ) {
        target[part] = {};
      }
      target = target[part] as Record<string, unknown>;
    }
    target[parts[parts.length - 1]] = value;
  }
  return config;
}

/**
 * Ensure hatch always provides enough initial LLM config for the assistant to
 * detect a fresh off-cloud hatch and seed BYOK profiles.
 */
export function buildHatchConfigValues(
  configValues: Record<string, string>,
  provider: string | null | undefined,
): Record<string, string> {
  if (!provider || configValues["llm.default.provider"]) {
    return configValues;
  }

  return {
    ...configValues,
    "llm.default.provider": provider,
  };
}

export interface ApplyHatchConfigOptions {
  /** The assistant's gateway base URL. */
  gatewayUrl: string;
  /** Guardian bearer token leased for this hatch (settings.write scope). */
  bearerToken?: string;
  /** Flat dot-notation config values to set, e.g. `llm.default.provider`. */
  configValues: Record<string, string>;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
}

/**
 * Apply hatch config values through the assistant's config API after it
 * wakes. One `POST /v1/config/set` per dotted path — the same route the web
 * client and `assistant config set` use — so local and remote hatches behave
 * identically and every value rides the daemon's validated, hot-applied
 * config write.
 *
 * Best-effort: a failed key logs a warning and the remaining keys still try,
 * mirroring the provider-credential step that follows it. The assistant is
 * still hatched; the values can be re-applied with `assistant config set`.
 */
export async function applyHatchConfig(
  options: ApplyHatchConfigOptions,
): Promise<void> {
  const log = options.log ?? console.log;
  const keys = Object.keys(options.configValues);
  if (keys.length === 0) {
    return;
  }

  if (!options.bearerToken) {
    log(
      "⚠️  Initial config skipped because the guardian token was not leased.\n" +
        "   The assistant is still hatched. Re-apply with `assistant config set <path> <value>`.",
    );
    return;
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  for (const path of keys) {
    try {
      const response = await fetchImpl(
        `${options.gatewayUrl.replace(/\/$/, "")}/v1/config/set`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${options.bearerToken}`,
          },
          body: JSON.stringify({ path, value: options.configValues[path] }),
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`HTTP ${response.status}${body ? `: ${body}` : ""}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(
        `⚠️  Failed to apply ${path}: ${message}\n` +
          "   The assistant is still hatched. Re-apply with `assistant config set`.",
      );
    }
  }
}
