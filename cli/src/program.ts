/**
 * The `cadet` CLI's commander program — the command tree, global flags, and
 * help live here, so parse bugs like #881's help-exits-1 class are the
 * library's problem, not ours.
 *
 * `tunnel` is a real commander tree (its subcommands and flags are declared,
 * and its execute layer lives beside the registration in its module). The
 * other commands are pass-throughs for now: each module still parses its own
 * argv — the entry keeps `process.argv` shaped the way they read it — and
 * each one converts to declared options in its own followup leg.
 */

import { Command } from "commander";

import { stampedVersion } from "@mycadet/shared/version";

import cliPkg from "../package.json";
import { backup } from "./commands/backup";
import { app } from "./commands/app";
import { client } from "./commands/client";
import { completeCadet, completions } from "./commands/completions";
import { confirm } from "./commands/confirm";
import { connect } from "./commands/connect";
import { devices } from "./commands/devices";
import { events } from "./commands/events";
import { exec } from "./commands/exec";
import { hatch } from "./commands/hatch";
import { login, logout, whoami } from "./commands/login";
import { logs } from "./commands/logs";
import { message } from "./commands/message";
import { pair } from "./commands/pair";
import { ps } from "./commands/ps";
import { restore } from "./commands/restore";
import { retire } from "./commands/retire";
import { restart } from "./commands/restart";
import { setup } from "./commands/setup";
import { sleep } from "./commands/sleep";
import { machine } from "./commands/machine";
import { debug } from "./commands/debug";
import { teleport } from "./commands/teleport";
import { terminal } from "./commands/terminal";
import { registerTunnelCommand } from "./commands/tunnel";
import { uninstall } from "./commands/uninstall";
import { upgrade } from "./commands/upgrade";
import { use } from "./commands/use";
import { voice } from "./commands/voice";
import { wake } from "./commands/wake";
import { red } from "./lib/color";

/** Every pass-through command, in the help-listing order the entry used. */
const PASS_THROUGH_COMMANDS = {
  backup,
  app,
  client,
  completions,
  confirm,
  connect,
  debug,
  devices,
  events,
  exec,
  hatch,
  login,
  logs,
  logout,
  machine,
  message,
  pair,
  ps,
  restore,
  retire,
  restart,
  setup,
  sleep,
  teleport,
  terminal,
  uninstall,
  upgrade,
  use,
  voice,
  wake,
  whoami,
} as const;

export function buildCadetProgram(): Command {
  const program = new Command();
  program
    .name("cadet")
    .description("Utilities for managing your Cadet assistants")
    .version(
      `@mycadet/cli v${stampedVersion(cliPkg.version)}`,
      "-v, --version",
    );

  // Color Commander-emitted error output red (unknown commands, parse
  // errors). Plain success output and --help text are untouched. The `red`
  // helper is a no-op when stderr isn't a TTY or NO_COLOR is set.
  program.configureOutput({
    outputError: (str, write) => write(red(str)),
  });

  registerTunnelCommand(program);

  for (const [name, command] of Object.entries(PASS_THROUGH_COMMANDS)) {
    program
      .command(name)
      .description(command.description)
      // The pass-through modules parse their own argv, including flags
      // commander has never heard of — dispatch is all commander does here.
      .allowUnknownOption()
      .allowExcessArguments(true)
      .action(() => command());
  }

  // Hidden completion hook: the bash completion script calls
  // `cadet __complete <words-up-to-cursor>` and filters the printed
  // candidates against the word under the cursor. Deliberately unlisted in
  // the help.
  program
    .command("__complete", { hidden: true })
    .allowUnknownOption()
    .allowExcessArguments(true)
    .action(() => {
      const candidates = completeCadet(
        process.argv.slice(3),
        Object.keys(PASS_THROUGH_COMMANDS).concat("tunnel"),
      );
      console.log(candidates.join("\n"));
      process.exit(0);
    });

  program.addHelpText(
    "after",
    `
Options:
  --no-color, --plain   Disable colored output (honors NO_COLOR env)`,
  );

  return program;
}
