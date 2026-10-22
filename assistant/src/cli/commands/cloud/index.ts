/**
 * `assistant cloud` — manage Cadet Cloud integration.
 *
 * Thin IPC wrapper that delegates all platform operations to the daemon.
 */

import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../../ipc/cli-client.js";
import { applyCommandHelp, subcommand } from "../../lib/cli-command-help.js";
import { registerCommand } from "../../lib/register-command.js";
import { log } from "../../logger.js";
import { shouldOutputJson, writeOutput } from "../../output.js";
import { registerCloudConnectCommand } from "./connect.js";
import { registerCloudDisconnectCommand } from "./disconnect.js";
import { cloudHelp } from "./index.help.js";

interface CloudStatusResult {
  isPlatform: boolean;
  baseUrl: string;
  assistantId: string;
  hasAssistantApiKey: boolean | null;
  hasWebhookSecret: boolean;
  available: boolean;
  organizationId: string | null;
  userId: string | null;
}

export function registerCloudCommand(program: Command): void {
  registerCommand(program, {
    name: cloudHelp.name,
    // `platform` stays as an alias for backwards compatibility with the
    // pre-rebrand spelling.
    aliases: ["platform"],
    transport: "ipc",
    description: cloudHelp.description,
    build: (platform) => {
      applyCommandHelp(platform, cloudHelp);

      // -----------------------------------------------------------------------
      // connect
      // -----------------------------------------------------------------------

      registerCloudConnectCommand(platform);

      // -----------------------------------------------------------------------
      // status
      // -----------------------------------------------------------------------

      subcommand(platform, "status").action(
        async (_opts: Record<string, unknown>, cmd: Command) => {
          const r = await cliIpcCall<CloudStatusResult>("platform_status", {});
          if (!r.ok) {
            return exitFromIpcResult(
              { ok: false, error: r.error, statusCode: r.statusCode },
              cmd,
            );
          }

          const result = r.result!;

          if (shouldOutputJson(cmd)) {
            writeOutput(cmd, result);
          } else {
            log.info(`Platform: ${result.isPlatform}`);
            log.info(`Base URL: ${result.baseUrl || "(not set)"}`);
            log.info(`Assistant ID: ${result.assistantId || "(not set)"}`);
            log.info(
              `Assistant API key: ${
                result.hasAssistantApiKey === null
                  ? "unknown (credential store unreachable)"
                  : result.hasAssistantApiKey
                    ? "set"
                    : "not set"
              }`,
            );
            log.info(
              `Webhook secret: ${result.hasWebhookSecret ? "set" : "not set (run ensure-registration to provision)"}`,
            );
            log.info(
              `Callback registration available: ${result.available ? "yes" : "no"}`,
            );
            log.info(
              `Organization ID: ${result.organizationId || "(not set)"}`,
            );
            log.info(`User ID: ${result.userId || "(not set)"}`);
          }
        },
      );

      // -----------------------------------------------------------------------
      // disconnect
      // -----------------------------------------------------------------------

      registerCloudDisconnectCommand(platform);

      // -----------------------------------------------------------------------
      // callback-routes
      // -----------------------------------------------------------------------

      const callbackRoutes = subcommand(platform, "callback-routes");

      // -----------------------------------------------------------------------
      // callback-routes register
      // -----------------------------------------------------------------------

      subcommand(callbackRoutes, "register").action(
        async (opts: { path: string; type: string }, cmd: Command) => {
          const r = await cliIpcCall<{
            callbackUrl: string;
            callbackPath: string;
            type: string;
          }>("cloud_callback_routes_register", {
            body: { path: opts.path, type: opts.type },
          });
          if (!r.ok) {
            return exitFromIpcResult(
              { ok: false, error: r.error, statusCode: r.statusCode },
              cmd,
            );
          }

          writeOutput(cmd, { ok: true, ...r.result });

          if (!shouldOutputJson(cmd)) {
            log.info(`Callback route registered: ${r.result!.callbackUrl}`);
          }
        },
      );

      // -----------------------------------------------------------------------
      // callback-routes list
      // -----------------------------------------------------------------------

      subcommand(callbackRoutes, "list").action(
        async (_opts: Record<string, unknown>, cmd: Command) => {
          const r = await cliIpcCall<{
            routes: Array<{
              id: string;
              assistant_id: string;
              type: string;
              callback_path: string;
              callback_url: string;
            }>;
          }>("platform_callback_routes_list", {});
          if (!r.ok) {
            return exitFromIpcResult(
              { ok: false, error: r.error, statusCode: r.statusCode },
              cmd,
            );
          }

          const routes = r.result!.routes;

          if (shouldOutputJson(cmd)) {
            writeOutput(cmd, { ok: true, routes });
          } else {
            if (routes.length === 0) {
              log.info("No callback routes registered.");
            } else {
              log.info(`${routes.length} callback route(s) registered:\n`);
              for (const route of routes) {
                log.info(`  Type: ${route.type}`);
                log.info(`  URL:  ${route.callback_url}`);
                log.info(`  Path: ${route.callback_path}`);
                log.info("");
              }
            }
          }
        },
      );
    },
  });
}
