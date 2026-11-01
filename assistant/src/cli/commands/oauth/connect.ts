import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../../ipc/cli-client.js";
import { getCliLogger } from "../../../util/logger.js";
import { subcommand } from "../../lib/cli-command-help.js";
import { openInHostBrowser } from "../../lib/open-browser.js";
import { shouldOutputJson, writeOutput } from "../../output.js";

const log = getCliLogger("cli");

// ---------------------------------------------------------------------------
// IPC polling helpers
// ---------------------------------------------------------------------------

type OAuthConnectStatusResponse =
  | { status: "pending"; service: string }
  | {
      status: "complete";
      service: string;
      account_info?: string;
      granted_scopes?: string[];
    }
  | { status: "error"; service: string; error?: string };

async function pollOAuthConnectStatus(
  state: string,
  opts: { intervalMs: number; timeoutMs: number },
): Promise<OAuthConnectStatusResponse> {
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    const r = await cliIpcCall<OAuthConnectStatusResponse>(
      "internal_oauth_connect_status",
      { pathParams: { state } },
    );
    if (r.ok && r.result) {
      const { status } = r.result;
      if (status === "complete" || status === "error") {
        return r.result;
      }
    }
    if (!r.ok && r.statusCode !== undefined) {
      return {
        status: "error",
        service: "?",
        error: r.error ?? "assistant error during OAuth status poll",
      };
    }
    await new Promise<void>((res) => setTimeout(res, opts.intervalMs));
  }
  return {
    status: "error",
    service: "?",
    error: "Timed out waiting for OAuth callback",
  };
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerConnectCommand(oauth: Command): void {
  subcommand(oauth, "connect")
    // The preAction validation hook is imperative behaviour, not help data,
    // so it stays here alongside the action handler.
    .hook("preAction", (thisCommand) => {
      const transport = thisCommand.opts().callbackTransport;
      if (transport !== "loopback" && transport !== "gateway") {
        thisCommand.error(
          `Invalid --callback-transport value "${transport}". Must be "loopback" or "gateway".`,
        );
      }
    })
    .action(
      async (
        provider: string,
        opts: {
          scopes?: string[];
          browser?: boolean;
          clientId?: string;
          callbackTransport: "loopback" | "gateway";
        },
        cmd: Command,
      ) => {
        const jsonMode = shouldOutputJson(cmd);

        // Helper: write an error and set exit code
        const writeError = (error: string): void => {
          writeOutput(cmd, { ok: false, error });
          process.exitCode = 1;
        };

        try {
          // ---------------------------------------------------------------
          // 1. Validate provider exists via IPC
          // ---------------------------------------------------------------
          const providerCheck = await cliIpcCall<{
            provider: Record<string, unknown>;
          }>("oauth_providers_by_providerKey_get", {
            pathParams: { providerKey: provider },
          });

          if (!providerCheck.ok) {
            if (providerCheck.statusCode === 404) {
              writeError(
                `Unknown provider "${provider}". ` +
                  `Run 'assistant oauth providers list' to see available providers.`,
              );
              return;
            }
            return exitFromIpcResult(providerCheck);
          }

          const providerRow = providerCheck.result?.provider as
            | Record<string, unknown>
            | undefined;
          const authorizeUrl = providerRow?.authUrl as string | undefined;

          // Manual-token providers don't use OAuth2 browser flows
          if (authorizeUrl === "urn:manual-token") {
            writeError(
              `"${provider}" uses manual token configuration, not an OAuth browser flow. ` +
                `Collect the token securely with: assistant credentials prompt --service ${provider} --field <field_name> --label "<label>"`,
            );
            return;
          }

          // Use daemon-orchestrated path via existing internal routes
          const startBody: Record<string, unknown> = {
            service: provider,
            callbackTransport: opts.callbackTransport,
          };
          if (opts.clientId) {
            startBody.clientId = opts.clientId;
          }
          if (opts.scopes) {
            startBody.requestedScopes = opts.scopes;
          }

          const startResult = await cliIpcCall<{
            auth_url: string;
            state: string;
          }>("internal_oauth_connect_start", {
            body: startBody,
          });

          if (startResult.ok && startResult.result?.auth_url) {
            const { auth_url, state } = startResult.result;

            if (opts.browser !== false) {
              openInHostBrowser(auth_url);

              if (!jsonMode) {
                log.info(
                  "Waiting for authorization in browser... (press Ctrl+C to cancel)",
                );
              }
              const final = await pollOAuthConnectStatus(state, {
                intervalMs: 2000,
                timeoutMs: 5 * 60 * 1000,
              });

              if (final.status === "complete") {
                if (jsonMode) {
                  writeOutput(cmd, {
                    ok: true,
                    grantedScopes: final.granted_scopes ?? [],
                    accountInfo: final.account_info,
                  });
                } else {
                  process.stdout.write(
                    `Connected to ${provider}${final.account_info ? ` as ${final.account_info}` : ""}\n`,
                  );
                }
                return;
              }

              if (final.status === "error") {
                writeError(final.error ?? "OAuth connect failed");
                return;
              }

              writeError("OAuth connect ended in an unexpected pending state");
              return;
            } else {
              // --no-browser: return the URL immediately
              if (jsonMode) {
                writeOutput(cmd, {
                  ok: true,
                  deferred: true,
                  authUrl: auth_url,
                  state,
                  service: provider,
                });
              } else {
                process.stdout.write(
                  `\nAuthorize with ${provider}:\n\n${auth_url}\n\nThe connection will complete automatically once you authorize.\n`,
                );
              }
              return;
            }
          }

          if (startResult.ok && !startResult.result?.auth_url) {
            writeError(
              "assistant returned unexpected response for OAuth connect start",
            );
            return;
          }

          if (!startResult.ok && startResult.statusCode !== undefined) {
            writeError(
              startResult.error ?? "OAuth connect failed (assistant error)",
            );
            return;
          }

          writeError(
            startResult.error
              ? `Could not reach the assistant: ${startResult.error}. Is the assistant running?`
              : "Could not reach the assistant. Is the assistant running?",
          );
          return;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          writeError(message);
        }
      },
    );
}
