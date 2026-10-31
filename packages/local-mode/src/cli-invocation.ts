/**
 * The CLI-invocation resolution, inlined into the library that runs the CLI.
 *
 * Every local-mode lifecycle op (`runHatch`, `runSleep`,
 * `runUpgrade`, `runWake`) spawns the `cadet` CLI as a subprocess; WHERE the
 * CLI lives is this resolution, not each host's concern: the
 * `CADET_CLI_PATH` override wins, then the host's installed/dev candidates
 * (a packaged desktop app carries its own installer and resources — passed
 * once via {@link configureLocalMode}'s `cliPaths`), then this repo's own
 * checkout (the library walks up from its module dir), so a host passes
 * paths, never a resolver callback.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import type { CliInvocation } from "./util";

/** The host-varying CLI facts a desktop app supplies at configure time. */
export interface CliPaths {
  /**
   * The host's installed/dev invocation candidates, probed in order — a
   * packaged app names its bundled bun + installed CLI (and the installer
   * through `prepare`, awaited before the probe so a first-run hatch can
   * install before the path exists).
   */
  installed?: () => Array<{ bun: string; cli: string }>;
  /**
   * The host's dev-checkout CLI entry probe (e.g. the repo an unpackaged
   * app runs from) — the host applies its own packaging checks and
   * existsSync; a probe returning undefined skips the candidate.
   */
  devEntry?: () => string | undefined;
  /** Awaited before probing installed candidates (the host's installer). */
  prepare?: () => Promise<void>;
}

let cliPaths: CliPaths | undefined;

/** Configure the host's CLI facts (once, at local-mode setup). */
export function configureCliPaths(next: CliPaths | undefined): void {
  cliPaths = next;
}

/** The repo's own checkout CLI entry, found by walking up from this module. */
function findRepoCliEntry(): string | null {
  let dir = dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, "cli", "src", "index.ts");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

export async function resolveCliInvocation(): Promise<CliInvocation> {
  const envPath = process.env.CADET_CLI_PATH;
  if (envPath) {
    return { command: "bun", baseArgs: ["run", envPath] };
  }
  const devEntry = cliPaths?.devEntry?.();
  if (devEntry) {
    // The host only hands over a dev entry it has verified (its own
    // existsSync behind app packaging checks) — trust it as given.
    return { command: "bun", baseArgs: ["run", devEntry] };
  }
  // A packaged app's installer guarantees the installed pair once `prepare`
  // resolves — the host's own resolution, not something to re-probe.
  if (cliPaths?.prepare) {
    await cliPaths.prepare();
  }
  const installed = cliPaths?.installed?.()?.[0];
  if (installed) {
    return { command: installed.bun, baseArgs: ["run", installed.cli] };
  }
  const repoEntry = findRepoCliEntry();
  if (repoEntry) {
    return { command: "bun", baseArgs: ["run", repoEntry] };
  }
  throw new Error(
    "No cadet CLI found: set CADET_CLI_PATH, install the CLI, or run from a repo checkout.",
  );
}
