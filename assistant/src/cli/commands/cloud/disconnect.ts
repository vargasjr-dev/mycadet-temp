import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../../ipc/cli-client.js";
import { subcommand } from "../../lib/cli-command-help.js";
import { log } from "../../logger.js";
import { shouldOutputJson, writeOutput } from "../../output.js";

export function registerCloudDisconnectCommand(cloud: Command): void {
  subcommand(cloud, "disconnect").action(
    async (_opts: Record<string, unknown>, cmd: Command) => {
      const r = await cliIpcCall<{
        disconnected: boolean;
        previousBaseUrl: string | null;
      }>("cloud_disconnect", {});
      if (!r.ok) {
        return exitFromIpcResult(
          { ok: false, error: r.error, statusCode: r.statusCode },
          cmd,
        );
      }

      writeOutput(cmd, { ok: true, ...r.result });

      if (!shouldOutputJson(cmd)) {
        const prev = r.result?.previousBaseUrl;
        log.info(`Disconnected from cloud${prev ? ` at ${prev}` : ""}`);
      }
    },
  );
}
