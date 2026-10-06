/**
 * Cadet home-directory contract.
 *
 * Defines where the Cadet install keeps its per-user state (`~/.cadet`) and
 * how an existing Vellum install (`~/.vellum`) is adopted on first run.
 *
 * Migration rule: COPY, never move. The legacy `~/.vellum` directory is left
 * fully intact so a pre-rebrand install (or a rollback) keeps working. The
 * copy is performed into a sibling staging directory and atomically renamed
 * into place, so concurrent processes (daemon, CLI, CES, desktop client)
 * either see no `.cadet` yet or a complete copy — never a partial one.
 *
 * If the copy fails (permissions, disk full), callers fall back to the legacy
 * directory so the install keeps working; the next launch retries.
 *
 * This module is intentionally dependency-free (node builtins only, like the
 * rest of this package's runtime code) so every side — assistant daemon, CLI,
 * CES, desktop — can import it without circular references.
 *
 * Scope note: this contract covers the per-user HOME root only. Platform-
 * managed containers keep their mount layout (`.vellum` inside the assistant
 * data mount) as a platform-template contract, migrated server-side later.
 */

import { cpSync, existsSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

/** The Cadet per-user state directory name (under the user's home). */
export const CADET_DIR_NAME = ".cadet";

/** The legacy (pre-rebrand) per-user state directory name. */
export const LEGACY_VELLUM_DIR_NAME = ".vellum";

/** `<parent>/.cadet` — pure path arithmetic, no filesystem access. */
export function cadetHomePath(parentDir: string): string {
  return join(parentDir, CADET_DIR_NAME);
}

/** `<parent>/.vellum` — pure path arithmetic, no filesystem access. */
export function legacyVellumHomePath(parentDir: string): string {
  return join(parentDir, LEGACY_VELLUM_DIR_NAME);
}

export type CadetHomeOrigin =
  /** Neither `.cadet` nor `.vellum` existed — fresh install, nothing created. */
  | "fresh"
  /** `.cadet` already existed (previous run or another process won). */
  | "existing"
  /** Legacy `.vellum` was found and copied to `.cadet` (original left intact). */
  | "copied"
  /** Copy failed; using the legacy directory so the install keeps working. */
  | "legacy-fallback";

export interface CadetHomeResolution {
  /** The directory callers should use as the per-user state root. */
  dir: string;
  origin: CadetHomeOrigin;
}

export interface EnsureCadetHomeOptions {
  /**
   * Copy implementation — overridable for tests. Defaults to a recursive
   * `cpSync` that preserves symlinks (they are copied as links, not
   * dereferenced, matching `cp -R` semantics for in-place state).
   */
  copyDir?: (from: string, to: string) => void;
}

/**
 * Resolve (and if needed adopt) the Cadet home directory under `parentDir`.
 *
 * - `.cadet` exists → use it, touch nothing.
 * - else `.vellum` exists → copy it to `.cadet` (copy-not-move, atomic via
 *   staging + rename) and use `.cadet`.
 * - else → fresh install: return the `.cadet` path without creating it
 *   (callers `mkdir -p` on demand, exactly as they did for `.vellum`).
 *
 * Idempotent and safe to call from multiple processes.
 */
export function ensureCadetHomeAt(
  parentDir: string,
  options: EnsureCadetHomeOptions = {},
): CadetHomeResolution {
  const cadetDir = cadetHomePath(parentDir);
  if (existsSync(cadetDir)) {
    return { dir: cadetDir, origin: "existing" };
  }

  const legacyDir = legacyVellumHomePath(parentDir);
  if (!existsSync(legacyDir)) {
    return { dir: cadetDir, origin: "fresh" };
  }

  const copy =
    options.copyDir ?? ((from, to) => cpSync(from, to, { recursive: true }));
  const staging = `${cadetDir}.migrating-${process.pid}-${Date.now()}`;
  try {
    copy(legacyDir, staging);
    try {
      renameSync(staging, cadetDir);
      return { dir: cadetDir, origin: "copied" };
    } catch {
      // rename loses only when cadetDir already exists (another process
      // completed the migration first) — its complete copy is as good as ours.
      if (!existsSync(cadetDir)) {
        throw new Error(`Could not migrate ${legacyDir} to ${cadetDir}`);
      }
      rmSync(staging, { recursive: true, force: true });
      return { dir: cadetDir, origin: "existing" };
    }
  } catch {
    // Copy failed — clean up any staging output and keep the install working
    // on the legacy directory. The next launch retries the migration.
    rmSync(staging, { recursive: true, force: true });
    return { dir: legacyDir, origin: "legacy-fallback" };
  }
}
