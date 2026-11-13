/**
 * `assistant logs` CLI namespace.
 *
 * Subcommands:
 *   info — print the current logging setup: log dir, today's log file,
 *          retention, and the per-module level overrides.
 *   set  — write a `logFile.levels.<kind>` entry directly to the workspace
 *          config.json (no IPC proxy). The running daemon's config watcher
 *          hot-applies the new level on the file change; with no daemon
 *          running, the level simply applies at next boot.
 */

import { basename, join } from "node:path";

import type { Command } from "commander";

import { getLogsDir } from "../../util/layout.js";
import { getCurrentLogFilePath } from "../../util/logger.js";
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
    transport: "local",
    description: logsHelp.description,
    build: (logs) => {
      applyCommandHelp(logs, logsHelp);

      subcommand(logs, "info")
        .description("Show the assistant's current logging setup")
        .action(async () => {
          // The config loader and schema are daemon-internal — keep them out
          // of the CLI's static graph (see the eslint cli/no-daemon-internals
          // rule) by importing lazily.
          const loader = await import("../../config/loader.js");
          const logging = await import("../../config/schemas/logging.js");
          let logFile: {
            dir?: string;
            retentionDays: number;
            levels: Record<string, string>;
          };
          try {
            logFile = logging.LogFileConfigSchema.parse(
              loader.loadRawConfig().logFile ?? {},
            );
          } catch (err) {
            log.error(
              `config.json has an invalid logFile section: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
            process.exitCode = 1;
            return;
          }
          const dir = logFile.dir ?? getLogsDir();
          const levels = Object.entries(logFile.levels);
          log.info(`log dir:      ${dir}`);
          log.info(
            `current file: ${join(dir, basename(getCurrentLogFilePath()))}`,
          );
          log.info(`retention:    ${logFile.retentionDays} days`);
          if (levels.length > 0) {
            log.info(
              `levels:       ${levels.map(([k, v]) => `${k}=${v}`).join(", ")}`,
            );
          } else {
            log.info("levels:       (none overridden — modules log at info)");
          }
        });

      subcommand(logs, "set")
        .description("Set a module's log level, applied live")
        .action(async (opts: { kind: string; level: string }) => {
          // The config schema and loader are daemon-internal — keep them out
          // of the CLI's static graph (see the eslint cli/no-daemon-internals
          // rule) by importing lazily.
          const loader = await import("../../config/loader.js");
          const logging = await import("../../config/schemas/logging.js");
          const kind = resolveKind(opts.kind);
          const level = opts.level as (typeof logging.LOG_LEVELS)[number];
          if (!logging.LOG_LEVELS.includes(level)) {
            log.error(
              `Unknown level '${opts.level}'. Use one of: ${logging.LOG_LEVELS.join(", ")}`,
            );
            process.exitCode = 1;
            return;
          }
          if (
            !logging.LOG_MODULES.includes(
              kind as (typeof logging.LOG_MODULES)[number],
            )
          ) {
            log.error(
              `Unknown kind '${opts.kind}'. Use one of: ${logging.LOG_MODULES.join(", ")}`,
            );
            process.exitCode = 1;
            return;
          }

          const raw = loader.loadRawConfig();
          loader.setNestedValue(raw, `logFile.levels.${kind}`, level);
          loader.saveRawConfig(raw);
          log.info(
            `${kind} log level set to ${level} in config.json — the running assistant hot-applies it within a second.`,
          );
        });
    },
  });
}
