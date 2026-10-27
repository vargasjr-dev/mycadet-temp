import { SEEDS } from "@mycadet/environments";

import { resolveEnvironmentName } from "./environment";
import {
  assertSafePathSegment,
  environmentDirectoryName,
  joinLocalPath,
  resolveConfigHome,
  resolveDataHome,
} from "./paths";

const PRODUCTION_ENVIRONMENT_NAME = "production";

export interface LocalEndpointConfig {
  lockfilePath: string;
  configDir: string;
  cloudUrl: string;
}

/**
 * Resolve the local endpoint config from the process environment.
 */
export function resolveLocalConfigFromEnv(): LocalEndpointConfig {
  const cadetEnv = resolveEnvironmentName();
  const seed = SEEDS[cadetEnv] ?? SEEDS[PRODUCTION_ENVIRONMENT_NAME]!;

  return {
    lockfilePath: resolveLockfilePath(),
    configDir: resolveConfigDir(),
    cloudUrl: process.env.CADET_CLOUD_URL || seed.cloudUrl,
  };
}

export function resolveLockfilePath(): string {
  return joinLocalPath(resolveConfigDir(), "lockfile.json");
}

export function resolveConfigDir(): string {
  return joinLocalPath(
    resolveConfigHome(),
    environmentDirectoryName(resolveEnvironmentName()),
  );
}

export function resolveDataDir(): string {
  return joinLocalPath(
    resolveDataHome(),
    environmentDirectoryName(resolveEnvironmentName()),
  );
}

export function resolveLogDir(): string {
  const root =
    process.platform === "win32" ? resolveDataDir() : resolveConfigDir();
  return joinLocalPath(root, "logs");
}

export function resolveAssistantsDir(): string {
  return joinLocalPath(resolveDataDir(), "assistants");
}

export function resolveInstanceDir(assistantId: string): string {
  assertSafePathSegment(assistantId, "assistant ID");
  return joinLocalPath(resolveAssistantsDir(), assistantId);
}

/**
 * The on-disk location of an assistant's guardian token, given an already
 * resolved config dir. The single source of truth for this path so the CLI
 * writer and every host-seam reader agree — a divergence here is what leaves a
 * freshly leased token unreadable and bricks the connect.
 */
export function guardianTokenPath(assistantId: string): string {
  assertSafePathSegment(assistantId, "assistant ID");
  return joinLocalPath(
    resolveConfigDir(),
    "assistants",
    assistantId,
    "guardian-token.json",
  );
}
