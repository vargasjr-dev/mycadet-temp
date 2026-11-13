/**
 * `assistant logs` CLI namespace.
 *
 * Subcommand: set — a thin wrapper over the daemon's config_set IPC route,
 * writing a `logFile.levels.<kind>` entry. The daemon hot-applies the new
 * level (config-watcher + the config route both call applyModuleLogLevels),
 * so the change lands without a restart.
 */

import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../ipc/cli-client.js";
import { LOG_LEVELS, type LogLevel } from "../../config/schemas/logging.js";
import { applyCommandHelp, subcommand } from "../lib/cli-command-help.js";
import { registerCommand } from "../lib/register-command.js";
import { log } from "../logger.js";
import { logsHelp } from "./logs.help.js";

/** Friendly kind aliases → canonical logger module tags. */
const KIND_ALIASES: Record<string, string> = {
  http: "http-request",
  migrations: "workspace-migrations",
  graph: "graph-capability-seed",
  registry: "tool-registry",
};

function resolveKind(input: string): string {
  return KIND_ALIASES[input] ?? input;
}

export function registerLogsCommand(program: Command): void {
  registerCommand(program, {
    name: logsHelp.name,
    transport: "ipc",
    description: logsHelp.description,
    build: (logs) => {
      applyCommandHelp(logs, logsHelp);

      subcommand(logs, "set")
        .description("Set a module's log level, applied live")
        .requiredOption(
          "--kind <kind>",
          'logger module tag (e.g. "http-request"; "http" works too)',
        )
        .requiredOption("--level <level>", `one of: ${LOG_LEVELS.join(", ")}`)
        .action(async (opts: { kind: string; level: string }) => {
          const kind = resolveKind(opts.kind);
          const level = opts.level as LogLevel;
          if (!LOG_LEVELS.includes(level)) {
            log.error(
              `Unknown level '${opts.level}'. Use one of: ${LOG_LEVELS.join(", ")}`,
            );
            process.exitCode = 1;
            return;
          }

          const result = await cliIpcCall<{ ok: boolean; warning?: string }>(
            "config_set",
            { body: { path: `logFile.levels.${kind}`, value: level } },
          );
          if (!result.ok) {
            exitFromIpcResult(result, logs);
            return;
          }
          log.info(`${kind} log level set to ${level} — applied live.`);
          const warning = result.result?.warning;
          if (warning) {
            log.warn(`Warning: ${warning}`);
          }
        });
    },
  });
}
