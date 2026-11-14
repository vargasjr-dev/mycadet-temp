import { resolveEnvironmentName } from "@mycadet/shared/seeds";

// The package's own version. Workspace checkouts read 0.0.1; the release
// pipeline stamps every bundled package with the release version when it
// packs the CLI tarball, so an installed copy carries the same channel stamp
// as @mycadet/cli.
import { version as packageVersion } from "../package.json";

/** The version string this host reports for itself. Hosts bundling
 * local-mode without the CLI inject `__CADET_OWN_VERSION__` at build time;
 * unset, the package's own version decides. Never derived from git state at
 * runtime: an installed CLI running inside a user's git repo must not
 * mistake the user's HEAD for a build channel. (The environment resolver's
 * version channel reads the same global directly — see shared/seeds.) */
export function ownVersion(): string {
  return (
    (globalThis as { __CADET_OWN_VERSION__?: string }).__CADET_OWN_VERSION__ ??
    packageVersion
  );
}

const PRODUCTION_ENVIRONMENT_NAME = "production";

/**
 * The binary name the user actually invokes: production keeps the bare
 * `cadet`, every other environment installs as `cadet-<env>` — the same rule
 * the CLI's help text and recovery hints follow. Local-mode surfaces the
 * same name in its own user-facing strings (the `login` recovery hint the
 * auth-header resolution raises), so both packages resolve it through this
 * one rule instead of duplicating it.
 */
export function cliCommand(): string {
  const name = resolveEnvironmentName();
  return name === PRODUCTION_ENVIRONMENT_NAME ? "cadet" : `cadet-${name}`;
}
