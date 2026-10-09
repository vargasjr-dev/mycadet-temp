#!/usr/bin/env bun

import { join } from "path";
import { readFileSync } from "node:fs";

import {
  resolveConfigDir,
  SigningKeyContinuityError,
} from "@mycadet/local-mode";

import { emitCliError } from "./lib/cli-error.js";

import cliPkg from "../package.json";
import { backup } from "./commands/backup";
import { clean } from "./commands/clean";
import { client } from "./commands/client";
import { confirm } from "./commands/confirm";
import { connect } from "./commands/connect";
import { devices } from "./commands/devices";
import { events } from "./commands/events";
import { exec } from "./commands/exec";
import { flags } from "./commands/flags";
import { gateway } from "./commands/gateway";
import { hatch } from "./commands/hatch";
import { login, logout, whoami } from "./commands/login";
import { logs } from "./commands/logs";
import { message } from "./commands/message";
import { pair } from "./commands/pair";
import { ps } from "./commands/ps";
import { recover } from "./commands/recover";
import { restore } from "./commands/restore";
import { roadmap } from "./commands/roadmap";
import { retire } from "./commands/retire";
import { rollback } from "./commands/rollback";
import { setup } from "./commands/setup";
import { sleep } from "./commands/sleep";
import { ssh } from "./commands/ssh";
import { debug } from "./commands/debug";
import { teleport } from "./commands/teleport";
import { terminal } from "./commands/terminal";
import { tunnel } from "./commands/tunnel";
import { unpair } from "./commands/unpair";
import { upgrade } from "./commands/upgrade";
import { use } from "./commands/use";
import { voice } from "./commands/voice";
import { wake } from "./commands/wake";
import { workflows } from "./commands/workflows";
import { red } from "./lib/color";
import { resolveAssistant, setActiveAssistant } from "./lib/assistant-config";
import { loadGuardianToken } from "./lib/guardian-token";
import { checkHealth } from "./lib/health-check";

/**
 * Attach a one-line description to a command function. The help table
 * derives from these (see printHelp), so a command added here without a
 * description is a type error and the two lists can never drift.
 */
function withDescription(
  run: () => Promise<void>,
  description: string,
): (() => Promise<void>) & { description: string } {
  return Object.assign(run, { description });
}

const commands = {
  backup: withDescription(backup, "Export a backup of a running assistant"),
  clean: withDescription(clean, "Kill orphaned cadet processes"),
  client: withDescription(client, "Connect to a hatched assistant"),
  confirm: withDescription(
    confirm,
    "Resolve a pending tool confirmation on an assistant",
  ),
  connect: withDescription(
    connect,
    "Pair with an assistant running on another machine [beta]",
  ),
  debug: withDescription(
    debug,
    "Send Cadet staff a debug bundle of a self-hosted assistant",
  ),
  devices: withDescription(
    devices,
    "List or revoke devices paired to a local assistant [beta]",
  ),
  events: withDescription(events, "Stream events from a running assistant"),
  exec: withDescription(
    exec,
    "Execute a command inside an assistant's container",
  ),
  flags: withDescription(flags, "Show and toggle feature flags"),
  gateway: withDescription(gateway, "Gateway management commands"),
  hatch: withDescription(hatch, "Create a new assistant instance"),
  login: withDescription(login, "Log in to Cadet Cloud"),
  logout: withDescription(logout, "Log out of Cadet Cloud"),
  logs: withDescription(logs, "View logs from an assistant instance"),
  message: withDescription(
    message,
    "Send a message to a running assistant",
  ),
  pair: withDescription(
    pair,
    "Print a pairing link and QR code for another device [beta]",
  ),
  ps: withDescription(
    ps,
    "List assistants (or processes for a specific assistant)",
  ),
  recover: withDescription(
    recover,
    "Restore a previously retired local assistant",
  ),
  restore: withDescription(
    restore,
    "Restore data (and optionally version) from a .vbundle backup",
  ),
  retire: withDescription(retire, "Delete an assistant instance"),
  roadmap: withDescription(roadmap, "Manage roadmap items"),
  rollback: withDescription(
    rollback,
    "Roll back an assistant to a previous version",
  ),
  setup: withDescription(setup, "Configure API keys interactively"),
  sleep: withDescription(sleep, "Stop the assistant process"),
  ssh: withDescription(ssh, "SSH into a remote assistant instance"),
  teleport: withDescription(
    teleport,
    "Transfer assistant data between environments",
  ),
  terminal: withDescription(
    terminal,
    "Open a terminal into a managed assistant container",
  ),
  tunnel: withDescription(
    tunnel,
    "Create a tunnel for a locally hosted assistant",
  ),
  unpair: withDescription(
    unpair,
    "Forget a paired assistant imported from another machine [beta]",
  ),
  upgrade: withDescription(
    upgrade,
    "Upgrade an assistant to a newer version",
  ),
  use: withDescription(use, "Set the active assistant for commands"),
  voice: withDescription(
    voice,
    "Type to an assistant and hear it answer out loud",
  ),
  wake: withDescription(wake, "Start the assistant and gateway"),
  whoami: withDescription(whoami, "Show current logged-in user"),
  workflows: withDescription(workflows, "Inspect and control workflow runs"),
};

type CommandName = keyof typeof commands;

function printHelp(): void {
  console.log("Usage: cadet <command> [options]");
  console.log("");
  console.log("Commands:");
  const nameWidth = Math.max(
    ...Object.keys(commands).map((name) => name.length),
  );
  for (const [name, command] of Object.entries(commands)) {
    console.log(`  ${name.padEnd(nameWidth)}  ${command.description}`);
  }
  console.log("");
  console.log("Options:");
  console.log(
    "  --no-color, --plain   Disable colored output (honors NO_COLOR env)",
  );
  console.log("  --version, -v         Show version");
  console.log("  --help, -h            Show this help");
}

/**
 * Check for --no-color / --plain flags and set NO_COLOR env var
 * before any terminal capability detection runs.
 *
 * Per https://no-color.org/, setting NO_COLOR to any non-empty value
 * signals that color output should be suppressed.
 */
function applyNoColorFlags(argv: string[]): void {
  if (argv.includes("--no-color") || argv.includes("--plain")) {
    process.env.NO_COLOR = "1";
  }
}

/**
 * Load env vars from the cadet config dotenv file into `process.env` so
 * that `cadet hatch` forwards provider API keys to containers and other
 * commands have access to them.
 *
 * Reads `$XDG_CONFIG_HOME/cadet{-env}/.env` — the same config directory
 * the CLI uses for guardian tokens and environment state. The file is
 * written by remote-hatch scripts and can be user-managed.
 *
 * Existing `process.env` values take precedence (standard dotenv convention).
 * Only KEY=VALUE lines are parsed. Lines starting with # are comments.
 * Values may be quoted with single or double quotes.
 */
function loadConfigDotenv(): void {
  const configDir = resolveConfigDir(process.env);
  const envPath = join(configDir, ".env");

  let content: string;
  try {
    content = readFileSync(envPath, "utf-8");
  } catch {
    return;
  }

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    if (!key) continue;

    // Existing env vars take precedence (dotenv convention).
    if (process.env[key] !== undefined) continue;

    let value = trimmed.slice(eqIndex + 1).trim();
    // Strip surrounding quotes.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

/**
 * If a running assistant is detected, launch the TUI client and return true.
 * Otherwise return false so the caller can fall back to help text.
 */
async function tryLaunchClient(): Promise<boolean> {
  const entry = resolveAssistant();

  if (!entry) return false;

  const url = entry.localUrl || entry.runtimeUrl;
  if (!url) return false;

  const token = loadGuardianToken(entry.assistantId)?.accessToken;
  const result = await checkHealth(url, token);
  if (result.status !== "healthy") return false;

  // Ensure the resolved assistant is active so client() can find it
  // (client() independently reads the active assistant from config).
  setActiveAssistant(String(entry.assistantId));

  await client();
  return true;
}

async function main() {
  // Load $XDG_CONFIG_HOME/cadet/.env before any command runs so
  // provider API keys and other config are available to hatch, exec, etc.
  loadConfigDotenv();

  const args = process.argv.slice(2);

  // Must run before any command or terminal-capabilities usage
  applyNoColorFlags(args);

  // Global flags that are not command names
  const GLOBAL_FLAGS = new Set(["--no-color", "--plain"]);
  const commandName = args.find((a) => !GLOBAL_FLAGS.has(a));

  // Strip global flags from process.argv so subcommands that parse
  // process.argv.slice(3) don't see them as positional arguments.
  const filteredArgs = args.filter((a) => !GLOBAL_FLAGS.has(a));
  process.argv = [...process.argv.slice(0, 2), ...filteredArgs];

  if (commandName === "--version" || commandName === "-v") {
    console.log(`@mycadet/cli v${cliPkg.version}`);
    process.exit(0);
  }

  if (commandName === "--help" || commandName === "-h") {
    printHelp();
    process.exit(0);
  }

  if (!commandName) {
    const launched = await tryLaunchClient();
    if (!launched) {
      printHelp();
    }
    process.exit(0);
  }

  const command = commands[commandName as CommandName];

  if (!command) {
    console.error(red(`Unknown command: ${commandName}`));
    process.exit(1);
  }

  try {
    await command();
  } catch (error) {
    if (error instanceof SigningKeyContinuityError) {
      emitCliError("AUTH_IDENTITY_UNAVAILABLE", error.message, error.code);
    }
    console.error(red(`Error: ${error instanceof Error ? error.message : error}`));
    process.exit(1);
  }
}

main();
