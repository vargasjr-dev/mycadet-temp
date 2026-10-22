import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../../ipc/cli-client.js";
import type { CloudConnectResponse } from "../../../runtime/routes/cloud-routes.js";
import { subcommand } from "../../lib/cli-command-help.js";
import { log } from "../../logger.js";
import { shouldOutputJson, writeOutput } from "../../output.js";

export function registerCloudConnectCommand(cloud: Command): void {
  subcommand(cloud, "connect").action(
    async (_opts: Record<string, unknown>, cmd: Command) => {
      const r = await cliIpcCall<CloudConnectResponse>(
        "cloud_connect",
        {},
      );
      if (!r.ok) {
        return exitFromIpcResult(
          { ok: false, error: r.error, statusCode: r.statusCode },
          cmd,
        );
      }

      writeOutput(cmd, { ok: true, ...r.result });

      if (!shouldOutputJson(cmd)) {
        if (r.result?.alreadyConnected) {
          log.info(
            `Already connected to cloud at ${r.result.baseUrl}. ` +
              `Run 'assistant cloud disconnect' first to reconnect.`,
          );
        } else if (r.result?.credentialRejected) {
          // No client shows a login screen for the daemon's signal, so this
          // line is what tells the user what replaces the key. A plain sign-in
          // stops at "already logged in" before the credential pass runs;
          // --force runs it.
          log.info(
            "The stored cloud credential was rejected by the cloud. " +
              "Run 'cadet login --force' to sign in again and replace it.",
          );
        } else {
          log.info(
            "Showing the cloud login screen on connected clients. " +
              "Please complete the sign-in flow in the app.",
          );
        }
      }
    },
  );
}
