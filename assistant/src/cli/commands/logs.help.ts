/** Declarative help for the `assistant logs` command. */

import type { CliCommandHelp } from "../lib/cli-command-help.js";

export const logsHelp: CliCommandHelp = {
  name: "logs",
  description: "Set log levels on the running assistant (no restart needed)",
  helpText: `
Adjust per-module log levels at runtime. The daemon hot-applies the new
level — no restart. Levels: trace, debug, info, warn, error, silent.
Kinds are the logger module tags (http-request, workspace-migrations,
tool-registry, graph-capability-seed, db-init, home-greeting,
suggested-prompts); "http" is a shorthand for "http-request".

Examples:
  $ assistant logs set --kind http --level silent
  $ assistant logs set --kind migrations --level info
`,
};
