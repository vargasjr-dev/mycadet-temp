import { SEEDS, type EnvironmentDefinition } from "@mycadet/environments";

// Direct import — bun embeds this at compile time so it works in compiled binaries.
import cliPkg from "../../../package.json";
import { isDevVersion, isStagingVersion } from "../version-compat.js";

const DEFAULT_ENVIRONMENT_NAME = "production";

/**
 * Look up a seed entry by name. Returns `undefined` if no seed matches.
 * Callers that need the full resolution stack should use
 * {@link getCurrentEnvironment} instead. The returned definition is a
 * shallow copy so mutations by the caller don't leak back into the seed
 * table.
 */
export function getSeed(name: string): EnvironmentDefinition | undefined {
  const seed = SEEDS[name];
  if (!seed) return undefined;
  return { ...seed };
}

/**
 * Derive the environment from a CLI version string. Each client is tied to
 * exactly one environment — the one its version denotes — and cannot switch:
 *
 *   - `0.12.6-dev.<ts>.<sha>` (dev-release pipeline) → `dev`
 *   - `0.12.6-staging.N` (staging release pipeline)  → `staging`
 *   - `0.12.6` (stable release)                      → `production`
 *
 * The `local` seed stays reachable only via the `CADET_ENVIRONMENT` escape
 * hatch below, for source-tree development where no released version exists.
 */
export function environmentFromVersion(version: string): string {
  if (isDevVersion(version)) return "dev";
  if (isStagingVersion(version)) return "staging";
  return DEFAULT_ENVIRONMENT_NAME;
}

/**
 * Resolve the current environment definition.
 *
 * Priority:
 *   1. `CADET_ENVIRONMENT` env var — internal escape hatch for source-tree
 *      development and tests (e.g. `CADET_ENVIRONMENT=local bun cli`). Not
 *      a user-facing switching mechanism: released CLIs always resolve
 *      their environment from their own version.
 *   2. The environment denoted by the CLI's version (see
 *      {@link environmentFromVersion}).
 *
 * Per-field env-var overrides are honored on the resolved definition as
 * ad-hoc escape hatches (they do not materialize new environments):
 *   - `CADET_PLATFORM_URL` overrides `platformUrl`
 *   - `CADET_WEB_URL` overrides `webUrl`
 *   - `CADET_ASSISTANT_PLATFORM_URL` overrides `assistantPlatformUrl`
 *   - `CADET_LOCKFILE_DIR` overrides `lockfileDirOverride` (legacy e2e
 *     test hook)
 *
 * This function should be the single entrypoint for environment resolution.
 * No other code should drive off `CADET_ENVIRONMENT` directly.
 */
export function getCurrentEnvironment(
  override?: string,
): EnvironmentDefinition {
  const { name, source } = resolveEnvironmentSource(override);

  // Propagate the resolved environment into process.env so child processes
  // (daemon, gateway) inherit the same environment without needing to
  // re-derive it.
  if (source === "version" && !process.env.CADET_ENVIRONMENT) {
    process.env.CADET_ENVIRONMENT = name;
  }

  const seed = SEEDS[name];
  if (!seed) {
    if (name !== DEFAULT_ENVIRONMENT_NAME) {
      // Warn on stderr instead of throwing, to match the silent-fallback
      // behavior in assistant/src/util/platform.ts:getXdgCadetConfigDirName,
      // which silently falls back to production; the CLI agrees so neither
      // writer ends up in a disjoint state on a typo.
      process.stderr.write(
        `warning: unknown environment "${name}"; falling back to "${DEFAULT_ENVIRONMENT_NAME}". ` +
          `Add it to packages/environments/src/seeds.ts and rebuild if this was intentional.\n`,
      );
    }
    const fallback = SEEDS[DEFAULT_ENVIRONMENT_NAME];
    if (!fallback) {
      throw new Error(
        `fatal: default environment "${DEFAULT_ENVIRONMENT_NAME}" missing from seed table — this is a build error`,
      );
    }
    return { ...fallback };
  }

  const resolved: EnvironmentDefinition = { ...seed };

  const platformUrlOverride = process.env.CADET_PLATFORM_URL?.trim();
  if (platformUrlOverride) {
    resolved.platformUrl = platformUrlOverride;
  }

  const webUrlOverride = process.env.CADET_WEB_URL?.trim();
  if (webUrlOverride) {
    resolved.webUrl = webUrlOverride;
  }

  const assistantPlatformUrlOverride =
    process.env.CADET_ASSISTANT_PLATFORM_URL?.trim();
  if (assistantPlatformUrlOverride) {
    resolved.assistantPlatformUrl = assistantPlatformUrlOverride;
  }

  const lockfileDirOverride = process.env.CADET_LOCKFILE_DIR?.trim();
  if (lockfileDirOverride) {
    resolved.lockfileDirOverride = lockfileDirOverride;
  }

  return resolved;
}

/**
 * Resolve the environment name and its source for diagnostics.
 */
export function resolveEnvironmentSource(override?: string): {
  name: string;
  source: "env" | "version";
} {
  const trimmedOverride = override?.trim();
  const envVar = trimmedOverride || process.env.CADET_ENVIRONMENT?.trim();
  if (envVar && envVar.length > 0) {
    return { name: envVar, source: "env" };
  }
  return {
    name: environmentFromVersion(cliPkg.version ?? ""),
    source: "version",
  };
}
