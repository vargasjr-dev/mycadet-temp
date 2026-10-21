import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../../ipc/cli-client.js";
import { subcommand } from "../../lib/cli-command-help.js";
import { shouldOutputJson, writeOutput } from "../../output.js";

export async function noConnectionsMessage(provider: string): Promise<string> {
  return `No active connections for ${provider}.\nConnect with \`assistant oauth connect ${provider}\`.\n`;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ConnectionSummary {
  id: string;
  account: string | null;
  grantedScopes: string[];
  status: string;
  expiresAt?: string | null;
  hasRefreshToken?: boolean;
}

interface OAuthStatusResponse {
  ok: boolean;
  provider: string;
  connections: ConnectionSummary[];
  hint?: string;
}

// ---------------------------------------------------------------------------
// Text formatting helpers
// ---------------------------------------------------------------------------

function formatConnection(c: ConnectionSummary): string {
  const lines: string[] = [];
  lines.push(`  ${c.account ?? "(no account)"}`);
  lines.push(`    Connection ID: ${c.id}`);
  lines.push(`    Status: ${c.status}`);
  if (c.grantedScopes.length > 0) {
    lines.push(`    Granted scopes: ${c.grantedScopes.join(", ")}`);
  } else {
    lines.push(`    Granted scopes: (none)`);
  }
  if (c.expiresAt) {
    lines.push(`    Expires: ${c.expiresAt}`);
  }
  if (c.hasRefreshToken !== undefined) {
    lines.push(`    Refresh token: ${c.hasRefreshToken ? "yes" : "no"}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerStatusCommand(oauth: Command): void {
  subcommand(oauth, "status").action(
    async (provider: string, _opts: Record<string, unknown>, cmd: Command) => {
      try {
        const r = await cliIpcCall<{
          ok: boolean;
          provider: string;
          connections: ConnectionSummary[];
        }>("oauth_status", {
          queryParams: { provider },
        });

        if (!r.ok) {
          return exitFromIpcResult(r);
        }

        const result = r.result! as OAuthStatusResponse;
        const { connections } = result;

        if (shouldOutputJson(cmd)) {
          writeOutput(cmd, result);
          return;
        }

        // Text output
        if (connections.length === 0) {
          process.stdout.write(await noConnectionsMessage(provider));
          return;
        }

        const blocks = connections.map((c) => formatConnection(c));
        process.stdout.write(
          `${provider} — ${connections.length} active connection(s):\n\n${blocks.join("\n\n")}\n`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        writeOutput(cmd, { ok: false, error: message });
        process.exitCode = 1;
      }
    },
  );
}
