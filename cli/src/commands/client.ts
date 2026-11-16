import { type LockfileAssistant } from "@mycadet/local-mode/contract";
import {
  findAssistantByName,
  resolveConversationKey,
} from "../lib/assistant-config";
import {
  fetchOrganizationId,
  formatAssistantLookupError,
  getActiveAssistant,
  getAssistantDisplayName,
  loadGuardianToken,
  lookupAssistantByIdentifier,
  loadFreshGuardianToken,
  readCloudToken,
  saveLockfileAssistant,
} from "@mycadet/local-mode";

import { normalizeRuntimeUrl } from "../lib/runtime-url";
import { getGatewayUrl } from "@mycadet/local-mode/contract";
import {
  CLI_INTERFACE_ID,
  getClientRegistrationHeaders,
} from "../lib/client-identity";
import { parseAssistantTargetArg } from "../lib/assistant-target-args.js";
import { fetchCloudAssistants } from "../lib/cloud-client";
import { tuiLog } from "../lib/tui-log";

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
};

interface ParsedArgs {
  runtimeUrl: string;
  assistantId: string;
  assistantName?: string;
  /** "cadet" for cloud-hosted assistants, undefined for local. */
  cloud?: string;
  /** Platform session token (X-Session-Token), set when cloud === "cloud". */
  cloudToken?: string;
  /** Guardian JWT (Authorization: Bearer), set for local assistants. */
  bearerToken?: string;
}

// Exported for unit testing the arg/auth resolution without launching the TUI.
export function parseArgs(): ParsedArgs {
  const args = process.argv.slice(3);

  const positionalName = parseAssistantTargetArg(args, [
    "--assistant-id",
    "-a",
  ]);
  const flagArgs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else if ((arg === "--assistant-id" || arg === "-a") && args[i + 1]) {
      flagArgs.push(arg, args[++i]);
    }
  }

  let entry: LockfileAssistant | null = null;
  if (positionalName) {
    const result = lookupAssistantByIdentifier(positionalName);
    if (result.status !== "found") {
      console.error(formatAssistantLookupError(positionalName, result));
      process.exit(1);
    }
    entry = result.entry;
  } else {
    const active = getActiveAssistant();
    if (active) {
      const result = lookupAssistantByIdentifier(active);
      if (result.status === "found") {
        entry = result.entry;
      }
      if (!entry) {
        console.error(
          `Active assistant '${active}' not found in lockfile. Set an active assistant with 'cadet use <name-or-id>'.`,
        );
        process.exit(1);
      }
    }
    if (!entry) {
      console.error(
        "No active assistant set. Set one with 'cadet use <name-or-id>' or specify one: 'cadet client <name-or-id>'.",
      );
      process.exit(1);
    }
  }
  if (!entry) {
    console.error("No assistant found. Hatch one first with 'cadet hatch'.");
    process.exit(1);
  }

  const runtimeUrl = getGatewayUrl(entry);
  let assistantId = entry.assistantId;
  let assistantName: string | undefined = getAssistantDisplayName(entry);
  const cloud = entry.cloud;

  // Platform-hosted assistants (cloud "cadet") use a session token; every
  // other topology — local, docker, and "paired" — uses a bearer guardian JWT.
  const cloudToken =
    cloud === "cloud" ? (readCloudToken() ?? undefined) : undefined;
  const bearerToken =
    cloud === "cloud"
      ? undefined
      : (loadGuardianToken(entry.assistantId)?.accessToken ?? undefined);

  for (let i = 0; i < flagArgs.length; i++) {
    const flag = flagArgs[i];
    const value = flagArgs[i + 1];
    if ((flag === "--assistant-id" || flag === "-a") && value) {
      assistantId = value;
      assistantName = undefined;
    }
  }

  return {
    runtimeUrl: normalizeRuntimeUrl(runtimeUrl),
    assistantId,
    assistantName,
    cloud,
    cloudToken,
    bearerToken,
  };
}

function printUsage(): void {
  console.log(`${ANSI.bold}cadet client${ANSI.reset} - Connect to a hatched assistant

${ANSI.bold}USAGE:${ANSI.reset}
    cadet client [name-or-id] [options]

${ANSI.bold}ARGUMENTS:${ANSI.reset}
    [name-or-id]               Assistant display name or ID (default: active)

${ANSI.bold}OPTIONS:${ANSI.reset}
    -a, --assistant-id <id>    Assistant ID
    -h, --help                 Show this help message

${ANSI.bold}EXAMPLES:${ANSI.reset}
    cadet client
    cadet client mycadet-foo

`);
}

async function maybeHydrateCloudAssistantName(
  assistantId: string,
  assistantName: string | undefined,
  cloud: string | undefined,
  cloudToken: string | undefined,
): Promise<string | undefined> {
  if (cloud !== "cloud" || assistantName || !cloudToken) {
    return assistantName;
  }

  try {
    const matchedAssistant = (await fetchCloudAssistants(cloudToken)).find(
      (assistant) => assistant.id === assistantId,
    );
    const hydratedName = matchedAssistant?.name.trim();
    if (!hydratedName) {
      return assistantName;
    }

    const entry = findAssistantByName(assistantId);
    if (entry && entry.name !== hydratedName) {
      saveLockfileAssistant({
        ...entry,
        name: hydratedName,
      });
    }

    return hydratedName;
  } catch {
    return assistantName;
  }
}

export const client = Object.assign(
  async function client(): Promise<void> {
    const {
      runtimeUrl,
      assistantId,
      assistantName: parsedAssistantName,
      cloud,
      cloudToken,
      bearerToken,
    } = parseArgs();

    tuiLog.init();
    tuiLog.info("session start", {
      runtimeUrl,
      assistantId,
      cloud,
    });

    const assistantName = await maybeHydrateCloudAssistantName(
      assistantId,
      parsedAssistantName,
      cloud,
      cloudToken,
    );

    // Build pre-constructed request headers merged from auth + client registration.
    // Spreading into every fetch site ensures consistency across REST and SSE endpoints.
    let auth: Record<string, string> | undefined;
    if (cloud === "cloud" && cloudToken) {
      const orgId = await fetchOrganizationId(cloudToken).catch((err) => {
        tuiLog.warn("failed to fetch organization id", { err: String(err) });
        return undefined;
      });
      auth = {
        "X-Session-Token": cloudToken,
        ...(orgId ? { "Cadet-Organization-Id": orgId } : {}),
        ...getClientRegistrationHeaders(CLI_INTERFACE_ID),
      };
    } else {
      // Renew a stale stored lease through the one door before the TUI opens.
      const fresh = await loadFreshGuardianToken(assistantId);
      const token = fresh?.accessToken ?? bearerToken;
      auth = {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...getClientRegistrationHeaders(CLI_INTERFACE_ID),
      };
    }

    // The CLI addresses its chat conversation by a client-minted uuid key
    // (web's temp-client-id pattern) — resolve-or-mint once, persisted on the
    // entry, so every session shares one conversation.
    const lookup = lookupAssistantByIdentifier(assistantId);
    const conversationKey =
      lookup.status === "found"
        ? resolveConversationKey(lookup.entry.assistantId)
        : undefined;

    const { renderChatApp } = await import("../components/DefaultMainScreen");

    process.stdout.write("\x1b[2J\x1b[H");

    const app = renderChatApp(
      runtimeUrl,
      assistantId,
      () => {
        tuiLog.info("session end (user disconnect)");
        tuiLog.close();
        app.unmount();
        process.stdout.write("\x1b[2J\x1b[H");
        console.log(`${ANSI.dim}Disconnected.${ANSI.reset}`);
        process.exit(0);
      },
      { auth, assistantName, conversationKey },
    );
  },
  { description: "Connect to a hatched assistant" },
);
