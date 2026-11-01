import { unlinkSync } from "node:fs";

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
 * The on-disk location of an assistant's Baseten sandbox access token, given
 * an already resolved config dir. Same contract as {@link guardianTokenPath}:
 * the single source of truth for this path so the CLI writer and every
 * host-seam reader agree — the desktop proxy reads the file the hatch wrote.
 * The token is a short-lived bearer for the sandbox's API server; it never
 * enters the lockfile (which crosses the renderer boundary).
 */
export function basetenTokenPath(assistantId: string): string {
  assertSafePathSegment(assistantId, "assistant ID");
  return joinLocalPath(
    resolveConfigDir(),
    "assistants",
    assistantId,
    "baseten-token.json",
  );
}

/**
 * Remove a retired guardian bootstrap secret file, if present. The secret
 * mechanism is gone (pairing is the bootstrap door); pre-retirement installs
 * still carry the xdg file on disk, so a successful lease unlinks it
 * best-effort — the credential must not rot on disk unread.
 */
export function deleteGuardianBootstrapSecret(assistantId: string): void {
  assertSafePathSegment(assistantId, "assistant ID");
  try {
    unlinkSync(
      joinLocalPath(
        resolveConfigDir(),
        "assistants",
        assistantId,
        "guardian-bootstrap-secret",
      ),
    );
  } catch {
    // Absent or unreadable — nothing to clean.
  }
}

/**
 * The on-disk location of an assistant's bearer token, given an already
 * resolved config dir. Same contract as {@link guardianTokenPath}. The
 * platform sync strips the bearer from the lockfile rows it writes and
 * persists it here instead; readers go through this path.
 */
export function assistantBearerTokenPath(assistantId: string): string {
  assertSafePathSegment(assistantId, "assistant ID");
  return joinLocalPath(
    resolveConfigDir(),
    "assistants",
    assistantId,
    "bearer-token",
  );
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
