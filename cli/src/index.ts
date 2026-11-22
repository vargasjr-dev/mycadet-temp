#!/usr/bin/env bun

import { join } from "path";
import { existsSync, readFileSync } from "node:fs";

import {
  checkHealth,
  resolveConfigDir,
  setLocalSourceRoot,
} from "@mycadet/local-mode";

import { buildCadetProgram } from "./program";
import { client } from "./commands/client";
import { red } from "./lib/color";
import { setActiveAssistant } from "./lib/assistant-config";
import { findAssistant } from "@mycadet/local-mode";

// Report where the source tree lives for local file resolution. Compiled
// or bundled hosts have a virtual import.meta.dir that is not on disk —
// reporting it would send every resolver walking a ghost tree.
if (typeof import.meta.dir === "string") {
  const sourceRoot = join(import.meta.dir, "..", "..");
  if (existsSync(sourceRoot)) {
    setLocalSourceRoot(sourceRoot);
  }
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
  const configDir = resolveConfigDir();
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
  const entry = findAssistant();

  if (!entry) return false;

  const health = await checkHealth(entry);
  if (health.status !== "healthy") return false;

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

  const rawArgs = process.argv.slice(2);

  // Must run before any command or terminal-capabilities usage
  applyNoColorFlags(rawArgs);

  // The pass-through modules parse their own argv (process.argv.slice(3)),
  // so strip the global flags from process.argv the way the pre-commander
  // entry did — commander never sees them, and neither do the modules.
  const GLOBAL_FLAGS = new Set(["--no-color", "--plain"]);
  const filteredArgs = rawArgs.filter((a) => !GLOBAL_FLAGS.has(a));
  process.argv = [process.argv[0], process.argv[1], ...filteredArgs];

  const program = buildCadetProgram();

  // A bare `cadet` launches the TUI client when a healthy assistant is
  // running — help is the fallback, not the primary. Commander's own
  // bare-program behavior (help + exit 1) would skip both.
  if (filteredArgs.length === 0) {
    const launched = await tryLaunchClient();
    if (!launched) {
      program.outputHelp();
    }
    process.exit(0);
  }

  try {
    await program.parseAsync(filteredArgs, { from: "user" });
  } catch (error) {
    console.error(
      red(`Error: ${error instanceof Error ? error.message : error}`),
    );
    process.exit(1);
  }
}

main();
