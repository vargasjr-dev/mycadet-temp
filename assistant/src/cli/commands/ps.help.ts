/** Declarative help for the `assistant ps` command. */

import type { CliCommandHelp } from "../lib/cli-command-help.js";

export const psHelp: CliCommandHelp = {
  name: "ps",
  description: "Show the assistant daemon's live process tree",
  options: [
    {
      flags: "--json",
      description: "Machine-readable JSON output",
    },
  ],
  helpText: `
Walks the daemon's OS process tree and reports every descendant process
parented to the assistant runtime — qdrant, the embed worker, the memory
worker (when the daemon owns it), MCP servers, and any other live children.
The tree is built from the native process table (/proc on Linux, ps on
macOS), so it reflects what is actually running, not a fixed subsystem list.

Each row shows a process name (up to 30 characters), PID, tool or plugin
source, originating conversation ID, CPU, and resident RAM in MiB.
Tool descendants inherit their nearest tracked tool's attribution.
CPU is sampled over roughly 200 ms as a percentage of one core (so a
multithreaded process can exceed 100%). Unavailable metrics show as '—'.
RPC connections to sibling services are not OS processes and are omitted.

Examples:
  $ assistant ps
  $ assistant ps --json`,
};
