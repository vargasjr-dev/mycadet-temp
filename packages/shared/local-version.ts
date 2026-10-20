import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The version string a source checkout reports for `--version`.
 *
 * Released CLIs carry their channel in the version itself (`-dev.`,
 * `-staging.`, nothing for production — see `environmentFromVersion`). A
 * source checkout reads the static version from package.json, which made
 * `cadet-local --version` indistinguishable from a production install. This
 * stamps a `-local.` postfix using the exact dev-release format
 * (`<base>-local.<yyyymmddhhmm>.<shortsha>`) so the output names both the
 * build kind and the checkout it came from.
 *
 * The stamp applies only when the CLI runs as Bun-executed TypeScript (a
 * source checkout); compiled installs keep the plain package.json version —
 * their channel is decided by the release pipeline, not the machine they run
 * on. A source tree without git history (a raw tarball) also stays unstamped,
 * since the sha is what makes the stamp meaningful.
 *
 * The timestamp is the HEAD COMMIT's time, not the process's clock: the same
 * checkout must stamp identically in every process, because the stamp rides
 * values that key reuse decisions (the nginx edge's served-config
 * fingerprint). A wall-clock stamp would drift every invocation and restart
 * the edge each time a new `cadet` process computed its fingerprint. The
 * commit time moves exactly when the sha does — every pull.
 */

function utcStamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}`
  );
}

function isSourceCheckout(entryPath: string): boolean {
  return entryPath.endsWith(".ts");
}

function gitRepoRoot(entryPath: string): string | null {
  let dir = dirname(entryPath);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function shortSha(root: string): string | null {
  const result = spawnSync("git", ["rev-parse", "--short=7", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  const sha = (result.stdout ?? "").trim();
  return sha || null;
}

function headCommitTime(root: string): Date | null {
  const result = spawnSync("git", ["show", "-s", "--format=%cI", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  const parsed = new Date((result.stdout ?? "").trim());
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function stampedVersion(
  base: string,
  now: Date = new Date(),
  entryPath: string = import.meta.path,
): string {
  if (!isSourceCheckout(entryPath)) return base;
  const root = gitRepoRoot(entryPath);
  if (!root) return base;
  const sha = shortSha(root);
  if (!sha) return base;
  // `now` is the fallback stamp (and the test seam); a git checkout always
  // has a HEAD commit time when it has a sha, so the fallback is the
  // git-less-tail case only.
  const stamp = headCommitTime(root) ?? now;
  return `${base}-local.${utcStamp(stamp)}.${sha}`;
}

/**
 * The version the calling package reports: its own package.json version,
 * stamped for local-environment source builds, plain otherwise — release
 * versions are decided by the release pipeline, never the machine.
 */
export function displayVersion(packageRoot: string = process.cwd()): string {
  let base = "";
  try {
    const pkg = JSON.parse(
      readFileSync(join(packageRoot, "package.json"), "utf8"),
    ) as { version?: string };
    base = typeof pkg.version === "string" ? pkg.version : "";
  } catch {
    return "";
  }
  if (!base) return "";
  if ((process.env.CADET_ENVIRONMENT || "local") !== "local") return base;
  return stampedVersion(base, new Date(), import.meta.path);
}
