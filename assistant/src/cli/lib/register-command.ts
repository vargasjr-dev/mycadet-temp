import type { Command } from "commander";

export type CommandTransport = "ipc" | "local" | "bootstrap";

interface RegisterCommandOpts {
  name: string;
  /** Extra command names that resolve to this command (e.g. `cloud` for `platform`). */
  aliases?: string[];
  transport: CommandTransport;
  description: string;
  build: (cmd: Command) => void;
}

export function registerCommand(
  parent: Command,
  opts: RegisterCommandOpts,
): Command {
  const cmd = parent.command(opts.name).description(opts.description);
  if (opts.aliases?.length) {
    cmd.aliases(opts.aliases);
  }
  opts.build(cmd);
  return cmd;
}
