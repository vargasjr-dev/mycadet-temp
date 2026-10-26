import { homedir } from "node:os";
import path from "node:path";

const PRODUCTION_ENVIRONMENT_NAME = "production";

const isWindows = () => process.platform === "win32";
const paths = () => (isWindows() ? path.win32 : path.posix);

export function resolveConfigHome(): string {
  if (isWindows()) {
    return (
      process.env.APPDATA?.trim() ||
      paths().join(homedir(), "AppData", "Roaming")
    );
  }
  return process.env.XDG_CONFIG_HOME?.trim() || paths().join(homedir(), ".config");
}

export function resolveConfigHomes(): string[] {
  const canonical = resolveConfigHome();
  if (!isWindows()) {
    return [canonical];
  }
  const legacy =
    process.env.XDG_CONFIG_HOME?.trim() || paths().join(homedir(), ".config");
  return canonical === legacy ? [canonical] : [canonical, legacy];
}

export function resolveDataHome(): string {
  if (isWindows()) {
    return (
      process.env.LOCALAPPDATA?.trim() ||
      paths().join(homedir(), "AppData", "Local")
    );
  }
  return process.env.XDG_DATA_HOME?.trim() || paths().join(homedir(), ".local", "share");
}

export const joinLocalPath = (...segments: string[]) => paths().join(...segments);

export function assertSafePathSegment(value: string, label: string): void {
  const unsafe =
    !value ||
    /[/\\\0]/.test(value) ||
    /^\.{1,2}$/.test(value) ||
    (isWindows() &&
      (/[<>:"|?*\u0000-\u001f]/.test(value) ||
        /[. ]$/.test(value) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)));
  if (unsafe) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

/**
 * The directory name an environment's state lives under: `cadet` for
 * production (the legacy location other environments must not collide with),
 * `cadet-<env>` otherwise. Exported so hosts that enumerate a SPECIFIC
 * environment's directories — the CLI's cross-environment detection — can
 * compose them from {@link resolveConfigHomes} and {@link resolveDataHome}
 * without an options bag threading through the ambient resolvers.
 */
export function environmentDirectoryName(cadetEnv: string): string {
  assertSafePathSegment(cadetEnv, "environment name");
  return cadetEnv === PRODUCTION_ENVIRONMENT_NAME
    ? "cadet"
    : `cadet-${cadetEnv}`;
}
