import type { LlmProviderId } from "@mycadet/local-mode";
import {
  formatProviderName,
  isSupportedLlmProvider,
  LLM_PROVIDER_ENV_VAR_NAMES,
  promptSecret,
} from "@mycadet/local-mode";

// Ranked for the hatch prompt: Cadet Cloud first (the cloud connection —
// no key to collect), then the hosted-inference gateways, then the BYO-key
// incumbents, then the rest, with the endpoint-supplied catalogs last.
export const HATCH_PROVIDER_CHOICES: readonly LlmProviderId[] = [
  "cadet",
  "fireworks",
  "baseten",
  "openrouter",
  "vercel-ai-gateway",
  "openai",
  "anthropic",
  "gemini",
  "together",
  "minimax",
  "atlascloud",
  "ionet",
  "poolside",
  "litellm",
  "opencode",
];

export function resolveHatchProvider(
  configValues: Record<string, string | undefined>,
): LlmProviderId | null {
  const provider = (
    resolveConfiguredMainAgentProvider(configValues) || "anthropic"
  ).toLowerCase();

  if (provider === "ollama") {
    return null;
  }

  if (!isSupportedLlmProvider(provider)) {
    throw new Error(
      `Provider '${provider}' does not have a supported API-key setup flow.`,
    );
  }

  return provider;
}

// Distinguishes an explicit `--config` provider from resolveHatchProvider's
// silent fallback to Anthropic, without duplicating its resolution order.
export function hasExplicitHatchProvider(
  configValues: Record<string, string | undefined>,
): boolean {
  return resolveConfiguredMainAgentProvider(configValues) !== undefined;
}

export interface ShouldPromptForHatchProviderOptions {
  configValues: Record<string, string | undefined>;
  setupProviderCredentials: boolean;
  hasProviderApiKey: boolean;
  stdinIsTTY: boolean | undefined;
}

export function shouldPromptForHatchProvider(
  options: ShouldPromptForHatchProviderOptions,
): boolean {
  return (
    options.setupProviderCredentials &&
    !options.hasProviderApiKey &&
    !hasExplicitHatchProvider(options.configValues) &&
    !!options.stdinIsTTY
  );
}

function resolveConfiguredMainAgentProvider(
  configValues: Record<string, string | undefined>,
): string | undefined {
  // Fresh hatches seed the active custom profile from llm.default and then
  // that active profile wins over static mainAgent call-site defaults. Match
  // that startup behavior so hatch prompts for the provider the assistant will
  // actually use on first chat.
  return (
    resolveProfileProvider(
      configValues,
      readConfigValue(configValues, "llm.activeProfile"),
    ) ??
    resolveFragmentProvider(configValues, "llm.default") ??
    resolveFragmentProvider(configValues, "llm.callSites.mainAgent") ??
    resolveProfileProvider(
      configValues,
      readConfigValue(configValues, "llm.callSites.mainAgent.profile"),
    )
  );
}

function resolveProfileProvider(
  configValues: Record<string, string | undefined>,
  profileName: string | undefined,
): string | undefined {
  if (!profileName) return undefined;
  return resolveFragmentProvider(configValues, `llm.profiles.${profileName}`);
}

function resolveFragmentProvider(
  configValues: Record<string, string | undefined>,
  prefix: string,
): string | undefined {
  const provider = readConfigValue(configValues, `${prefix}.provider`);
  if (provider) return provider;

  const model = readConfigValue(configValues, `${prefix}.model`);
  return model ? inferProviderFromModel(model) : undefined;
}

function readConfigValue(
  configValues: Record<string, string | undefined>,
  key: string,
): string | undefined {
  const value = configValues[key]?.trim();
  return value && value.length > 0 ? value : undefined;
}

/**
 * Infer the provider a bare model ID implies, mirroring the assistant
 * resolver's `getCatalogProviderForModel`: an ID listed by multiple catalog
 * providers resolves to the FIRST one in catalog order. Vendor prefixes unique
 * to one provider map to it; shared gateway IDs (e.g. `anthropic/*`) fall
 * through to openrouter, the earlier catalog entry. Drift guard:
 * `cli/src/__tests__/provider-inference-parity.test.ts`. Exported for tests.
 */
export function inferProviderFromModel(model: string): string | undefined {
  if (model.startsWith("claude-")) {
    return "anthropic";
  }
  if (model.startsWith("gpt-")) {
    return "openai";
  }
  if (model.startsWith("gemini-")) {
    return "gemini";
  }
  if (model.startsWith("accounts/fireworks/models/")) {
    return "fireworks";
  }
  if (model.startsWith("openai/gpt-5.6") || model.startsWith("openai/gpt-6-")) {
    // Listed by OpenRouter (#37856), the earlier catalog entry; the Vercel
    // AI Gateway does not carry these IDs.
    return "openrouter";
  }
  if (
    model === "meta-llama/Llama-3.3-70B-Instruct" ||
    model === "openai/gpt-oss-20b"
  ) {
    // IO Intelligence (io.net) exclusives; the remaining meta-llama/ IDs
    // belong to OpenRouter.
    return "ionet";
  }
  if (model.startsWith("openai/") || model.startsWith("xai/")) {
    return "vercel-ai-gateway";
  }
  if (model.startsWith("MiniMaxAI/")) {
    return "together";
  }
  if (model.startsWith("deepseek-ai/")) {
    return "atlascloud";
  }
  if (model.startsWith("thinkingmachines/")) {
    return "baseten";
  }
  if (model.startsWith("poolside/")) {
    return "poolside";
  }
  if (model === "jev-latest" || model.startsWith("jev-")) {
    return "typesafe";
  }
  if (model.includes("/")) {
    return "openrouter";
  }
  if (model === "llama3.2" || model === "mistral") {
    return "ollama";
  }
  return undefined;
}

function createLineReader(input: NodeJS.ReadStream): {
  readLine(): Promise<string>;
  dispose(): void;
} {
  let buffered = "";
  const queuedLines: string[] = [];
  let waitingResolve: ((line: string) => void) | null = null;
  // Ctrl-D (EOF) fires "end" with no trailing newline, so a pending read
  // would otherwise wait forever. Treat EOF as a blank line: any read
  // already waiting, and every read requested afterward, resolves to "".
  let ended = false;

  const onData = (chunk: Buffer | string): void => {
    buffered += chunk.toString();
    let newlineIndex: number;
    while ((newlineIndex = buffered.search(/[\r\n]/)) !== -1) {
      const terminatorLength =
        buffered[newlineIndex] === "\r" && buffered[newlineIndex + 1] === "\n"
          ? 2
          : 1;
      const line = buffered.slice(0, newlineIndex);
      buffered = buffered.slice(newlineIndex + terminatorLength);

      if (waitingResolve) {
        const resolve = waitingResolve;
        waitingResolve = null;
        resolve(line);
      } else {
        queuedLines.push(line);
      }
    }
  };

  const onEnd = (): void => {
    ended = true;
    if (waitingResolve) {
      const resolve = waitingResolve;
      waitingResolve = null;
      resolve("");
    }
  };

  input.resume();
  input.on("data", onData);
  input.on("end", onEnd);

  return {
    readLine(): Promise<string> {
      const queued = queuedLines.shift();
      if (queued !== undefined) {
        return Promise.resolve(queued);
      }
      if (ended) {
        return Promise.resolve("");
      }
      return new Promise((resolve) => {
        waitingResolve = resolve;
      });
    },
    dispose(): void {
      input.removeListener("data", onData);
      input.removeListener("end", onEnd);
      input.pause();
    },
  };
}

export async function promptLine(
  prompt: string,
  streams: {
    input?: NodeJS.ReadStream;
    output?: NodeJS.WriteStream;
  } = {},
): Promise<string> {
  const input = streams.input ?? process.stdin;
  const output = streams.output ?? process.stdout;

  output.write(prompt);

  const reader = createLineReader(input);
  try {
    return await reader.readLine();
  } finally {
    reader.dispose();
  }
}

export interface PromptProviderChoiceOptions {
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
  choices?: readonly LlmProviderId[];
}

// Resolves choices[0] on blank input: Enter takes the top-ranked default.
export async function promptProviderChoice(
  options: PromptProviderChoiceOptions = {},
): Promise<LlmProviderId | null> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const choices = options.choices ?? HATCH_PROVIDER_CHOICES;

  output.write("No LLM provider detected. Choose:\n\n");
  choices.forEach((provider, index) => {
    const suffix = index === 0 ? " (default)" : "";
    output.write(`  ${index + 1}) ${formatProviderName(provider)}${suffix}\n`);
  });
  output.write("\n");

  const defaultLabel = formatProviderName(choices[0]);
  const reader = createLineReader(input);
  try {
    for (;;) {
      output.write(
        `Enter a number (1-${choices.length}), or press Enter to keep the default (${defaultLabel}): `,
      );
      const answer = (await reader.readLine()).trim();

      if (answer === "") {
        return choices[0];
      }

      if (/^\d+$/.test(answer)) {
        const index = Number(answer);
        if (index >= 1 && index <= choices.length) {
          return choices[index - 1];
        }
      }

      output.write(
        `Please enter a number between 1 and ${choices.length}, or press Enter to skip.\n`,
      );
    }
  } finally {
    reader.dispose();
  }
}

/**
 * Collects the provider's API key from the user immediately after they pick
 * the provider, so the two prompts sit back-to-back instead of straddling
 * the (now quiet) startup logs. Returns undefined when there is nothing to
 * collect (keyless managed-connection providers, keys already in the
 * environment, non-interactive terminals); returns the trimmed answer —
 * possibly "" for an empty one — when the user was asked, so an empty
 * answer warns once instead of re-prompting after startup.
 */
export async function collectProviderApiKey(
  provider: LlmProviderId,
): Promise<string | undefined> {
  const envVarName = LLM_PROVIDER_ENV_VAR_NAMES[provider];
  if (!envVarName) return undefined;
  const envValue = process.env[envVarName]?.trim();
  if (envValue) return undefined;
  if (!process.stdin.isTTY) return undefined;
  return (
    await promptSecret(
      `Enter your ${formatProviderName(provider)} API key (${envVarName}): `,
    )
  ).trim();
}
