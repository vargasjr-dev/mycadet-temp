import { resolveAssistant } from "../lib/assistant-config.js";
import {
  getGatewayUrl,
  type LockfileAssistant,
} from "@mycadet/local-mode/contract";
import { cliCommand } from "../lib/cli-name.js";
import {
  leaseGuardianToken,
  loadGuardianToken,
  refreshGuardianToken,
} from "../lib/guardian-token.js";
import type { GuardianTokenData } from "@mycadet/local-mode";
import {
  ensureProviderApiKey,
  formatProviderName,
} from "../lib/provider-secrets.js";
import { yellow } from "../lib/color.js";

function parseSetupArgs(args: string[]): { provider?: string } {
  let provider: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--provider") {
      const value = args[i + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--provider requires a provider name.");
      }
      provider = value;
      i++;
    } else if (arg.startsWith("--provider=")) {
      provider = arg.slice("--provider=".length);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return { provider };
}

interface DefaultProviderResponse {
  provider?: string;
}

/** Parse the default-provider payload without a type assertion. */
function parseDefaultProviderResponse(value: unknown): DefaultProviderResponse {
  if (typeof value !== "object" || value === null) return {};
  const provider = "provider" in value ? value.provider : undefined;
  return typeof provider === "string" ? { provider } : {};
}

/**
 * Ask the active assistant which provider it routes by default
 * (`GET /v1/config/llm/default-provider`), so `cadet setup` without
 * `--provider` configures the connection the assistant actually uses —
 * e.g. the keyless Cadet Cloud cloud connection picked at hatch —
 * instead of blindly prompting for an API key. Falls back to cadet
 * when the runtime is unreachable or predates the endpoint; the
 * returned warning says why, for the caller to render.
 */
async function resolveDefaultProvider(
  gatewayUrl: string,
  bearerToken?: string,
): Promise<{ provider: string; warning?: string }> {
  try {
    const response = await fetch(
      `${gatewayUrl}/v1/config/llm/default-provider`,
      {
        headers: {
          "Content-Type": "application/json",
          ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
        },
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!response.ok) {
      return {
        provider: "cadet",
        warning: `Default provider lookup failed (gateway responded ${response.status}); falling back to Cadet Cloud.`,
      };
    }
    const data = parseDefaultProviderResponse(await response.json());
    const provider = data.provider?.trim().toLowerCase();
    return { provider: provider || "cadet" };
  } catch (error) {
    return {
      provider: "cadet",
      warning: `Default provider lookup failed (${error instanceof Error ? error.message : String(error)}); falling back to Cadet Cloud.`,
    };
  }
}

function isGuardianAccessTokenUsable(
  tokenData: GuardianTokenData | null,
): tokenData is GuardianTokenData {
  if (!tokenData?.accessToken) {
    return false;
  }
  const expiresAt = new Date(tokenData.accessTokenExpiresAt).getTime();
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

async function resolveSetupBearerToken(
  entry: LockfileAssistant,
  gatewayUrl: string,
): Promise<string | undefined> {
  const guardianToken = loadGuardianToken(entry.assistantId);
  if (isGuardianAccessTokenUsable(guardianToken)) {
    return guardianToken.accessToken;
  }

  if (guardianToken) {
    const refreshedToken = await refreshGuardianToken(
      gatewayUrl,
      entry.assistantId,
    );
    if (isGuardianAccessTokenUsable(refreshedToken)) {
      return refreshedToken.accessToken;
    }
  }

  try {
    const leasedToken = await leaseGuardianToken(entry);
    if (isGuardianAccessTokenUsable(leasedToken)) {
      return leasedToken.accessToken;
    }
  } catch {
    // Fall through, or let the setup request surface the gateway's auth
    // error below.
  }

  return undefined;
}

export const setup = Object.assign(
  async function setup(): Promise<void> {
    const args = process.argv.slice(3);

    if (args.includes("--help") || args.includes("-h")) {
      console.log(`Usage: ${cliCommand()} setup [--provider <provider>]`);
      console.log("");
      console.log("Configure a provider API key on the active assistant.");
      console.log("");
      console.log("Options:");
      console.log(
        "  --provider <provider>  Provider to configure. Defaults to Cadet Cloud",
      );
      console.log("");
      console.log("Behavior:");
      console.log(
        "  - Checks the active assistant for an existing provider key.",
      );
      console.log("  - Uses the matching environment variable when it is set.");
      console.log("  - Otherwise prompts securely without echoing the key.");
      console.log("");
      console.log("Examples:");
      console.log(`  ${cliCommand()} setup`);
      console.log(`  ANTHROPIC_API_KEY=... ${cliCommand()} setup`);
      console.log(`  ${cliCommand()} setup --provider openai`);
      process.exit(0);
    }

    let parsed: { provider?: string };
    try {
      parsed = parseSetupArgs(args);
    } catch (error) {
      console.error(error instanceof Error ? `Error: ${error.message}` : error);
      process.exit(1);
    }

    const entry = resolveAssistant();
    if (!entry) {
      console.error(
        "Error: No active assistant found. Run `cadet hatch` first.",
      );
      process.exit(1);
    }

    const gatewayUrl = getGatewayUrl(entry);
    const bearerToken = await resolveSetupBearerToken(entry, gatewayUrl);

    // Respect the assistant's configured default provider (e.g. Cadet Cloud
    // chosen at hatch) unless the caller named one explicitly — the runtime's
    // keyless cloud connection should not be greeted by an API-key prompt.
    let provider = parsed.provider;
    if (!provider) {
      const resolved = await resolveDefaultProvider(gatewayUrl, bearerToken);
      provider = resolved.provider;
      if (resolved.warning) {
        console.error(yellow(resolved.warning));
      }
    }

    console.log("Cadet Setup");
    console.log("============\n");

    try {
      const result = await ensureProviderApiKey({
        gatewayUrl,
        provider,
        bearerToken,
        env: process.env,
      });

      if (result.status === "already_configured") {
        console.log(
          `${formatProviderName(result.provider)} API key is already configured.`,
        );
        return;
      }

      if (result.status === "configured") {
        const providerName = formatProviderName(result.provider);
        const source = result.source === "env" ? " from the environment" : "";
        console.log(`\n${providerName} API key saved to assistant${source}.`);
        console.log("Setup complete.");
        return;
      }

      if (result.status === "skipped") {
        console.log(result.message);
        return;
      }

      console.error(`Error: ${result.message}`);
      process.exit(1);
    } catch (error) {
      console.error(
        error instanceof Error
          ? `Error: ${error.message}`
          : "Error: Setup failed.",
      );
      process.exit(1);
    }
  },
  { description: "Configure API keys interactively" },
);
