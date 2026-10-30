import { isCloudHome } from "../lib/cloud-values.js";
import { homedir } from "node:os";

import {
  findAssistantByName,
  formatAssistantLookupError,
  getActiveAssistant,
  getAssistantDisplayName,
  lookupAssistantByIdentifier,
  resolveAssistant,
  resolveConversationKey,
  type LockfileAssistant,
} from "../lib/assistant-config";
import {
  isLocalRuntimeEntry,
  saveLockfileAssistant,
} from "@mycadet/local-mode";
import { DAEMON_INTERNAL_ASSISTANT_ID, GATEWAY_PORT } from "../lib/constants";
import {
  loadGuardianToken,
  refreshGuardianToken,
  guardianTokenDueForRenewal,
} from "../lib/guardian-token";
import { normalizeRuntimeUrl, trustedRefreshUrl } from "../lib/runtime-url";
import { getGatewayUrl } from "@mycadet/local-mode/contract";
import {
  CLI_INTERFACE_ID,
  getClientRegistrationHeaders,
} from "../lib/client-identity";
import { parseAssistantTargetArg } from "../lib/assistant-target-args.js";
import {
  fetchOrganizationId,
  fetchCloudAssistants,
  readCloudToken,
} from "../lib/cloud-client";
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
  /** Assistant data root (home-collapsed) for the TUI details panel. */
  workspaceRoot?: string;
  /** "cadet" for cloud-hosted assistants, undefined for local. */
  cloud?: string;
  /** Platform session token (X-Session-Token), set when isCloudHome(cloud). */
  cloudToken?: string;
  /** Guardian JWT (Authorization: Bearer), set for local assistants. */
  bearerToken?: string;
}

/** Collapse the home prefix so panel paths read `~/...` instead of absolute. */
function collapseHomeForDisplay(dir: string): string {
  const home = homedir();
  if (dir === home) return "~";
  return dir.startsWith(`${home}/`) ? `~${dir.slice(home.length)}` : dir;
}

/** The assistant's data root (from the lockfile), for the TUI details panel. */
function readWorkspaceRoot(
  entry: LockfileAssistant | null,
): string | undefined {
  if (!entry || !isLocalRuntimeEntry(entry)) return undefined;
  const instanceDir = entry.resources?.instanceDir;
  return instanceDir ? collapseHomeForDisplay(instanceDir) : undefined;
}

// Exported for unit testing the arg/auth resolution without launching the TUI.
export function parseArgs(): ParsedArgs {
  const args = process.argv.slice(3);

  const positionalName = parseAssistantTargetArg(args, [
    "--url",
    "-u",
    "--assistant-id",
    "-a",
    "--token",
    "-t",
  ]);
  const flagArgs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else if (
      (arg === "--url" ||
        arg === "-u" ||
        arg === "--assistant-id" ||
        arg === "-a" ||
        arg === "--token" ||
        arg === "-t") &&
      args[i + 1]
    ) {
      flagArgs.push(arg, args[++i]);
    }
  }

  let entry: LockfileAssistant | null = null;
  const hasExplicitUrl = flagArgs.includes("--url") || flagArgs.includes("-u");
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
      if (!entry && !hasExplicitUrl) {
        console.error(
          `Active assistant '${active}' not found in lockfile. Set an active assistant with 'cadet use <name-or-id>'.`,
        );
        process.exit(1);
      }
    }
    if (!entry && hasExplicitUrl) {
      // URL provided but active assistant missing or unset — resolve for remaining defaults
      entry = resolveAssistant();
    } else if (!entry) {
      console.error(
        "No active assistant set. Set one with 'cadet use <name-or-id>' or specify one: 'cadet client <name-or-id>'.",
      );
      process.exit(1);
    }
  }

  if (!entry && !hasExplicitUrl) {
    console.error("No assistant found. Hatch one first with 'cadet hatch'.");
    process.exit(1);
  }

  // An explicit --url with no lockfile entry is the ephemeral session (the
  // handed-over --token authenticates it) — the overrides below supply the
  // url and the "self" assistant id, so no entry is required.
  let runtimeUrl = entry
    ? getGatewayUrl(entry)
    : `http://127.0.0.1:${GATEWAY_PORT}`;
  let assistantId = entry?.assistantId ?? DAEMON_INTERNAL_ASSISTANT_ID;
  let assistantName = entry ? getAssistantDisplayName(entry) : undefined;
  const cloud = entry?.cloud;
  const workspaceRoot = readWorkspaceRoot(entry);

  // Ephemeral auth: a handed-over token (e.g. from `cadet pair`) used for this
  // session only. Resolve it BEFORE the credential lookup below so an ephemeral
  // session never reads (or writes) the local token store.
  let bearerTokenOverride: string | undefined;
  for (let i = 0; i < flagArgs.length; i++) {
    if (
      (flagArgs[i] === "--token" || flagArgs[i] === "-t") &&
      flagArgs[i + 1]
    ) {
      bearerTokenOverride = flagArgs[i + 1];
    }
  }

  // Platform-hosted assistants (cloud "cadet") use a session token; every
  // other topology — local, docker, and "paired" (a remote assistant paired
  // from another machine) — uses a bearer guardian JWT. Both are skipped
  // entirely when --token supplies the credential, so no saved creds are read.
  const cloudToken = bearerTokenOverride
    ? undefined
    : isCloudHome(cloud)
      ? (readCloudToken() ?? undefined)
      : undefined;
  const bearerToken = bearerTokenOverride
    ? bearerTokenOverride
    : isCloudHome(cloud)
      ? undefined
      : (loadGuardianToken(entry?.assistantId ?? "")?.accessToken ?? undefined);

  for (let i = 0; i < flagArgs.length; i++) {
    const flag = flagArgs[i];
    if ((flag === "--url" || flag === "-u") && flagArgs[i + 1]) {
      runtimeUrl = flagArgs[++i];
    } else if (
      (flag === "--assistant-id" || flag === "-a") &&
      flagArgs[i + 1]
    ) {
      assistantId = flagArgs[++i];
      assistantName = undefined;
    }
  }

  return {
    runtimeUrl: normalizeRuntimeUrl(runtimeUrl),
    assistantId,
    assistantName,
    workspaceRoot,
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
    -u, --url <url>            Runtime URL
    -t, --token <jwt>          Bearer token to use for this session (e.g. from
                              'cadet pair'). Overrides the stored token and is
                              not persisted.
    -a, --assistant-id <id>    Assistant ID
    -h, --help                 Show this help message

${ANSI.bold}EXAMPLES:${ANSI.reset}
    cadet client
    cadet client mycadet-foo
    # Remote assistants must be reached over https (e.g. a tunnel) — the
    # guardian refresh token is only sent over https or a loopback address:
    cadet client --url https://your-tunnel.example
    cadet client mycadet-foo --url http://localhost:${GATEWAY_PORT}

    # Ephemeral: connect to another machine's assistant with a paired token
    # (no lockfile entry, nothing persisted):
    cadet client --url https://your-tunnel.example --token <jwt>

`);
}

async function maybeHydrateCloudAssistantName(
  assistantId: string,
  assistantName: string | undefined,
  cloud: string | undefined,
  cloudToken: string | undefined,
): Promise<string | undefined> {
  if (!isCloudHome(cloud) || assistantName || !cloudToken) {
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

/**
 * Return a possibly-refreshed bearer token for the TUI's startup auth.
 *
 * Only a STORED guardian token is refreshable: platform session auth
 * (`isCloudHome(cloud)`) and ephemeral `--token` overrides (whose token won't
 * match the store) are left untouched, as is a token that's still fresh. When
 * the stored token has passed its `refreshAfter` (or expiry) and a refresh
 * token is available, refresh once via the concurrency-safe refreshGuardianToken
 * and use the rotated access token. Falls back to the existing token if refresh
 * isn't possible/fails — the session still starts (same as before).
 */
export async function resolveFreshBearerToken(
  runtimeUrl: string,
  assistantId: string,
  bearerToken: string | undefined,
  cloud: string | undefined,
): Promise<string | undefined> {
  if (isCloudHome(cloud) || !bearerToken || !assistantId) return bearerToken;

  const stored = loadGuardianToken(assistantId);
  // Refresh only the stored token (an ephemeral --token won't match), and only
  // when a refresh credential is present.
  if (!stored || stored.accessToken !== bearerToken || !stored.refreshToken) {
    return bearerToken;
  }

  // Only refresh once the stored token is actually due for renewal.
  if (!guardianTokenDueForRenewal(stored)) return bearerToken;

  // SECURITY: bind the refresh to the entry's persisted URL. `--url`/`-u` can
  // override `runtimeUrl` while still reusing this stored guardian token, so a
  // poisoned/attacker URL must not receive the long-lived refreshToken +
  // deviceId. Refresh only when the URL is one of the entry's persisted URLs,
  // and send to the trusted persisted URL — not the caller-supplied one.
  const lookup = lookupAssistantByIdentifier(assistantId);
  if (lookup.status !== "found") return bearerToken;
  const refreshUrl = trustedRefreshUrl(lookup.entry, runtimeUrl);
  if (!refreshUrl) return bearerToken;

  const refreshed = await refreshGuardianToken(refreshUrl, assistantId);
  return refreshed?.accessToken ?? bearerToken;
}

export const client = Object.assign(
  async function client(): Promise<void> {
    const {
      runtimeUrl,
      assistantId,
      assistantName: parsedAssistantName,
      workspaceRoot,
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
    if (isCloudHome(cloud) && cloudToken) {
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
      // Proactively refresh a stale STORED guardian token before opening the TUI,
      // so launching after the access token expired renews transparently rather
      // than erroring. (Mid-session expiry — the token dying while the TUI is
      // already open — is a separate follow-up, since the TUI threads a static
      // auth object through React.)
      const token = await resolveFreshBearerToken(
        runtimeUrl,
        assistantId,
        bearerToken,
        cloud,
      );
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
        ? resolveConversationKey(lookup.entry)
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
      { auth, assistantName, workspaceRoot, conversationKey },
    );
  },
  { description: "Connect to a hatched assistant" },
);
