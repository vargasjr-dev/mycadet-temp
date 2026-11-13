/** Declarative help for the `assistant logs` command. */

import type { CliCommandHelp } from "../lib/cli-command-help.js";

export const logsHelp: CliCommandHelp = {
  name: "logs",
  description: "Inspect and configure the assistant's logging setup",
  helpText: `
Inspect the logging setup and adjust per-module log levels. Writes go
directly to the workspace config.json — the running daemon hot-applies the
new level from the file change, no restart. Levels: trace, debug, info,
warn, error, silent. Kinds are the logger module tags (http-request,
workspace-migrations, tool-registry, graph-capability-seed, db-init,
home-greeting, suggested-prompts); "http" is a shorthand for "http-request".

Examples:
  $ assistant logs info
  $ assistant logs set --kind http --level silent
  $ assistant logs set --kind migrations --level info
`,
  subcommands: [
    {
      name: "info",
      description:
        "Show the current logging setup: log dir, today's file, retention, levels",
      options: [],
    },
    {
      name: "set",
      description: "Set a module's log level, applied live",
      options: [
        {
          flags: "--kind <kind>",
          description:
            'logger module tag (e.g. "http-request"; "http" works too)',
          required: true,
        },
        {
          flags: "--level <level>",
          description: "one of: trace, debug, info, warn, error, silent",
          required: true,
        },
      ],
    },
  ],
};
