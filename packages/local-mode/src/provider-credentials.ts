/**
 * The provider API-key setup machinery: the gateway credential-store API
 * (/v1/secrets), the provider vocabulary (env vars + display labels), and
 * the ensure/configure flow every hatch and `cadet setup` runs. The
 * interactive PROMPT CHOICE machinery (provider menus, config-vocab
 * resolution) stays in the CLI — this module is what runs once a provider
 * is chosen.
 */
import { LLM_PROVIDER_ENV_VAR_NAMES as LLM_PROVIDER_ENV_VAR_NAMES } from "./provider-env-vars";

export type LlmProviderId = keyof typeof LLM_PROVIDER_ENV_VAR_NAMES;

export type ProviderApiKeySource = "env" | "prompt";
export type ProviderSecretFetch = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => ReturnType<typeof fetch>;

export type EnsureProviderApiKeyResult =
  | {
      status: "already_configured";
      provider: LlmProviderId;
    }
  | {
      status: "configured";
      provider: LlmProviderId;
      source: ProviderApiKeySource;
    }
  | {
      status: "missing";
      provider: LlmProviderId;
      message: string;
    }
  | {
      status: "failed";
      provider: LlmProviderId;
      message: string;
    }
  | {
      status: "skipped";
      message: string;
    };

export interface EnsureProviderApiKeyOptions {
  gatewayUrl: string;
  provider: string | null;
  bearerToken?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: ProviderSecretFetch;
  prompt?: (prompt: string) => Promise<string>;
  stdinIsTTY?: boolean;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
  /** Key collected before startup, right after the provider choice. */
  precollectedKey?: string;
}

export interface GatewayApiKeyReadResult {
  found: boolean;
  unreachable: boolean;
}

export interface HatchProviderApiKeyOptions {
  gatewayUrl: string;
  provider: LlmProviderId | null;
  bearerToken?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: ProviderSecretFetch;
  log?: (message: string) => void;
  prompt?: (prompt: string) => Promise<string>;
  stdinIsTTY?: boolean;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
  /** Key collected before startup, right after the provider choice. */
  precollectedKey?: string;
}

const PROVIDER_LABELS: Record<LlmProviderId, string> = {
  cadet: "Cadet Cloud",
  anthropic: "Anthropic",
  openai: "OpenAI",
  gemini: "Gemini",
  fireworks: "Fireworks",
  openrouter: "OpenRouter",
  "vercel-ai-gateway": "Vercel AI Gateway",
  minimax: "MiniMax",
  atlascloud: "Atlas Cloud",
  together: "Together AI",
  litellm: "LiteLLM",
  opencode: "OpenCode",
  baseten: "Baseten",
  ionet: "IO Intelligence",
  poolside: "Poolside",
  typesafe: "TypeSafe",
};

export function formatProviderName(provider: LlmProviderId): string {
  return PROVIDER_LABELS[provider];
}

export function isSupportedLlmProvider(
  provider: string,
): provider is LlmProviderId {
  return Object.hasOwn(LLM_PROVIDER_ENV_VAR_NAMES, provider);
}

function gatewayUrlWithPath(gatewayUrl: string, path: string): string {
  return `${gatewayUrl.replace(/\/+$/, "")}${path}`;
}

function secretHeaders(bearerToken?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (bearerToken) {
    headers.Authorization = `Bearer ${bearerToken}`;
  }
  return headers;
}

async function parseErrorMessage(response: Response): Promise<string> {
  let text = "";
  try {
    text = await response.text();
  } catch {
    // Fall through to status text.
  }

  try {
    const body = JSON.parse(text) as {
      error?: unknown;
    };
    const message = extractErrorMessage(body.error);
    if (message) return message;
  } catch {
    // Fall back to raw text below.
  }

  if (text.trim().length > 0) {
    return text.trim();
  }

  return response.statusText || `HTTP ${response.status}`;
}

function extractErrorMessage(error: unknown): string | null {
  if (typeof error === "string" && error.trim().length > 0) {
    return error.trim();
  }
  if (!error || typeof error !== "object") {
    return null;
  }

  const maybeMessage = (error as { message?: unknown }).message;
  if (typeof maybeMessage === "string" && maybeMessage.trim().length > 0) {
    return maybeMessage.trim();
  }

  return null;
}

export async function readGatewayApiKey(
  gatewayUrl: string,
  provider: LlmProviderId,
  bearerToken?: string,
  fetchImpl: ProviderSecretFetch = fetch,
): Promise<GatewayApiKeyReadResult> {
  const response = await fetchImpl(
    gatewayUrlWithPath(gatewayUrl, "/v1/secrets/read"),
    {
      method: "POST",
      headers: secretHeaders(bearerToken),
      body: JSON.stringify({
        type: "api_key",
        name: provider,
        reveal: false,
      }),
      signal: AbortSignal.timeout(10_000),
    },
  );

  if (!response.ok) {
    const message = await parseErrorMessage(response);
    if (response.status === 404) {
      throw new Error(
        `Active assistant at ${gatewayUrl} does not expose /v1/secrets/read (${message}). Run \`cadet ps\` to confirm the active assistant, then select a self-hosted assistant with \`cadet use <assistant>\` or wake a current assistant before running setup.`,
      );
    }
    throw new Error(
      `Failed to check ${formatProviderName(provider)} API key: ${message}`,
    );
  }

  const body = (await response.json()) as {
    found?: unknown;
    unreachable?: unknown;
  };
  return {
    found: body.found === true,
    unreachable: body.unreachable === true,
  };
}

export async function injectGatewayApiKey(
  gatewayUrl: string,
  provider: LlmProviderId,
  value: string,
  bearerToken?: string,
  fetchImpl: ProviderSecretFetch = fetch,
): Promise<void> {
  const response = await fetchImpl(
    gatewayUrlWithPath(gatewayUrl, "/v1/secrets"),
    {
      method: "POST",
      headers: secretHeaders(bearerToken),
      body: JSON.stringify({
        type: "api_key",
        name: provider,
        value,
      }),
      signal: AbortSignal.timeout(10_000),
    },
  );

  if (!response.ok) {
    const message = await parseErrorMessage(response);
    throw new Error(
      `Failed to store ${formatProviderName(provider)} API key: ${message}`,
    );
  }

  const body = (await response.json().catch(() => ({}))) as {
    success?: unknown;
    error?: unknown;
  };
  if (body.success === false) {
    const message =
      typeof body.error === "string" && body.error.trim().length > 0
        ? body.error
        : "Assistant rejected the API key.";
    throw new Error(message);
  }
}

export async function promptSecret(
  prompt: string,
  streams: {
    input?: NodeJS.ReadStream;
    output?: NodeJS.WriteStream;
  } = {},
): Promise<string> {
  const input = streams.input ?? process.stdin;
  const output = streams.output ?? process.stdout;

  if (!input.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("Hidden secret input requires an interactive terminal.");
  }

  const wasRaw = input.isRaw;
  let rawModeEnabled = false;
  try {
    input.setRawMode(true);
    rawModeEnabled = true;
    output.write(prompt);
  } catch (error) {
    if (rawModeEnabled) {
      input.setRawMode(wasRaw ?? false);
    }
    throw error;
  }

  return new Promise((resolve, reject) => {
    input.resume();

    let value = "";

    const cleanup = (): void => {
      input.removeListener("data", onData);
      input.setRawMode(wasRaw ?? false);
      input.pause();
    };

    const finish = (): void => {
      cleanup();
      output.write("\n");
      resolve(value);
    };

    const cancel = (): void => {
      cleanup();
      output.write("\n");
      reject(new Error("Input cancelled."));
    };

    const onData = (chunk: Buffer | string): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (bytes[0] === 27) {
        return;
      }

      for (const byte of bytes) {
        if (byte === 3) {
          cancel();
          return;
        }
        if (byte === 10 || byte === 13) {
          finish();
          return;
        }
        if (byte === 8 || byte === 127) {
          value = value.slice(0, -1);
          continue;
        }
        if (byte >= 32 && byte <= 126) {
          value += String.fromCharCode(byte);
        }
      }
    };

    input.on("data", onData);
  });
}

export async function ensureProviderApiKey(
  options: EnsureProviderApiKeyOptions,
): Promise<EnsureProviderApiKeyResult> {
  if (options.provider === null) {
    return {
      status: "skipped",
      message: "Selected provider does not require an API key.",
    };
  }

  const normalizedProvider = options.provider.trim().toLowerCase();
  const providerName = isSupportedLlmProvider(normalizedProvider)
    ? formatProviderName(normalizedProvider)
    : options.provider;
  const envVarName = LLM_PROVIDER_ENV_VAR_NAMES[normalizedProvider];

  if (!envVarName) {
    // Managed-connection provider (e.g. Cadet Cloud): authenticated through
    // the cloud, not a user-supplied API key. Checked before the
    // supported-provider guard so the keyless flow stays reachable.
    return {
      status: "skipped",
      message: `${providerName} authenticates through the cloud connection; no API key needed.`,
    };
  }

  if (!isSupportedLlmProvider(normalizedProvider)) {
    throw new Error(
      `Provider '${options.provider}' does not have a supported API-key setup flow.`,
    );
  }
  const provider = normalizedProvider;
  const fetchImpl = options.fetchImpl ?? fetch;

  const existing = await readGatewayApiKey(
    options.gatewayUrl,
    provider,
    options.bearerToken,
    fetchImpl,
  );
  if (existing.unreachable) {
    return {
      status: "failed",
      provider,
      message:
        "Assistant credential store is unavailable. Try again after the assistant finishes starting.",
    };
  }
  if (existing.found) {
    return {
      status: "already_configured",
      provider,
    };
  }

  const envValue = options.env?.[envVarName]?.trim();
  const precollected = options.precollectedKey?.trim();

  // An empty pre-collected answer means the user already chose to skip the
  // key — do not re-prompt after startup.
  if (options.precollectedKey !== undefined && !precollected) {
    return {
      status: "missing",
      provider,
      message: "API key cannot be empty.",
    };
  }

  let apiKey = precollected || envValue;
  let source: ProviderApiKeySource =
    precollected && precollected !== envValue ? "prompt" : "env";

  if (!apiKey) {
    source = "prompt";
    if (options.prompt) {
      apiKey = (
        await options.prompt(
          `Enter your ${providerName} API key (${envVarName}): `,
        )
      ).trim();
    } else {
      const stdinIsTTY = options.stdinIsTTY ?? process.stdin.isTTY;
      if (!stdinIsTTY) {
        return {
          status: "missing",
          provider,
          message: `Missing ${envVarName}. Set it in the environment or run cadet setup from an interactive terminal.`,
        };
      }
      apiKey = (
        await promptSecret(
          `Enter your ${providerName} API key (${envVarName}): `,
          {
            input: options.input,
            output: options.output,
          },
        )
      ).trim();
    }
  }

  if (!apiKey) {
    return {
      status: "missing",
      provider,
      message: "API key cannot be empty.",
    };
  }

  await injectGatewayApiKey(
    options.gatewayUrl,
    provider,
    apiKey,
    options.bearerToken,
    fetchImpl,
  );

  return {
    status: "configured",
    provider,
    source,
  };
}

export async function configureHatchProviderApiKey(
  options: HatchProviderApiKeyOptions,
): Promise<void> {
  const log = options.log ?? console.log;
  const { provider } = options;

  if (provider === null) {
    log("Provider credentials not required for the selected provider.");
    return;
  }

  try {
    const result = await ensureProviderApiKey({
      gatewayUrl: options.gatewayUrl,
      provider,
      bearerToken: options.bearerToken,
      env: options.env,
      fetchImpl: options.fetchImpl,
      prompt: options.prompt,
      stdinIsTTY: options.stdinIsTTY,
      input: options.input,
      output: options.output,
      precollectedKey: options.precollectedKey,
    });

    if (
      result.status === "already_configured" ||
      result.status === "configured" ||
      result.status === "skipped"
    ) {
      // Success is the expected outcome — stay quiet and let the final
      // summary speak.
      return;
    }

    log(
      `⚠️  Provider credential setup skipped: ${result.message}\n` +
        `   The assistant is still hatched. Run \`cadet setup --provider ${provider}\` to finish setup.`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(
      `⚠️  Provider credential setup failed: ${message}\n` +
        `   The assistant is still hatched. Run \`cadet setup --provider ${provider}\` after fixing the issue.`,
    );
  }
}
