import { SEEDS, type EnvironmentDefinition } from "@mycadet/environments";

// Direct import — bun embeds this at compile time so it works in compiled binaries.
import cliPkg from "../../../package.json";
import {
  isDevVersion,
  isLocalVersion,
  isStagingVersion,
} from "@mycadet/shared/version";

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
 * Each CLI is tied to the environment denoted by its version:
 * `-local.` → local, `-dev.` → dev, `-staging.` → staging, stable → production.
 */
export function environmentFromVersion(version: string): string {
  if (isLocalVersion(version)) return "local";
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
 *   - `CADET_CLOUD_URL` overrides `cloudUrl`
 *   - `CADET_WEB_URL` overrides `webUrl`
 *   - `CADET_ASSISTANT_PLATFORM_URL` overrides `assistantCloudUrl`
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
      // Warn on stderr instead of throwing: an unknown environment falls back
      // to production, so a typo never splits writes between two states.
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

  const cloudUrlOverride = process.env.CADET_CLOUD_URL?.trim();
  if (cloudUrlOverride) {
    resolved.cloudUrl = cloudUrlOverride;
  }

  const webUrlOverride = process.env.CADET_WEB_URL?.trim();
  if (webUrlOverride) {
    resolved.webUrl = webUrlOverride;
  }

  const assistantCloudUrlOverride =
    process.env.CADET_ASSISTANT_PLATFORM_URL?.trim();
  if (assistantCloudUrlOverride) {
    resolved.assistantCloudUrl = assistantCloudUrlOverride;
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
