/**
 * Device ID resolver.
 *
 * Reads or creates a stable per-workspace UUID stored in device.json at the
 * root of the workspace directory. The file is a JSON object
 * (`{ "deviceId": "<uuid>" }`) extensible for future per-device metadata.
 *
 * Resolution order for the ID itself:
 *   1. The `CADET_DEVICE_ID` env var takes precedence when set and is never
 *      written to device.json (see getDeviceIdOverride in
 *      config/env-registry.ts). The CLI injects it when spawning the
 *      daemon/gateway so a machine's instances share one identity.
 *   2. `deviceId` from device.json in the workspace.
 *   3. A generated UUID, persisted to device.json.
 *
 * The value is cached in memory after the first successful read/write.
 * Falls back to a generated UUID if the file cannot be read or written.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getDeviceIdOverride } from "../config/env-registry.js";
import { getLogger } from "./logger.js";
import { getWorkspaceDir } from "./platform.js";

const log = getLogger("device-id");

let cached: string | undefined;

/**
 * Resolve the directory and file path for `device.json` — always the root
 * of the workspace directory. The device ID is a per-workspace identity;
 * machine-wide identity is the CLI's concern (it injects CADET_DEVICE_ID).
 */
export function resolveDeviceIdPaths(): { dir: string; file: string } {
  const dir = getWorkspaceDir();
  return { dir, file: join(dir, "device.json") };
}

function readDeviceIdFromFile(filePath: string): string | null {
  if (!existsSync(filePath)) {
    return null;
  }

  const raw = JSON.parse(readFileSync(filePath, "utf-8"));
  if (
    raw &&
    typeof raw === "object" &&
    typeof raw.deviceId === "string" &&
    raw.deviceId.length > 0
  ) {
    return raw.deviceId as string;
  }
  return null;
}

/**
 * Read the current stable device ID without creating or writing device.json.
 */
export function getExistingDeviceId(): string | null {
  if (cached !== undefined) {
    return cached;
  }

  const fromEnv = getDeviceIdOverride();
  if (fromEnv) {
    cached = fromEnv;
    log.info({ deviceId: cached }, "Resolved device ID from CADET_DEVICE_ID");
    return cached;
  }

  const { file: filePath } = resolveDeviceIdPaths();
  try {
    const existing = readDeviceIdFromFile(filePath);
    if (existing) {
      cached = existing;
      log.info({ deviceId: cached }, "Resolved device ID from device.json");
      return cached;
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Get the stable device ID for this workspace.
 *
 * Resolution order:
 *   1. Cached in-memory value (populated on first call)
 *   2. `CADET_DEVICE_ID` env var (CLI-injected; see env-registry)
 *   3. `deviceId` field from device.json
 *   4. Generate a new UUID, persist it to device.json, and return it
 *
 * On any read/write error the generated UUID is still cached so the
 * process uses a consistent ID for the remainder of its lifetime.
 */
export function getDeviceId(): string {
  if (cached !== undefined) {
    return cached;
  }

  const fromEnv = getDeviceIdOverride();
  if (fromEnv) {
    cached = fromEnv;
    log.info({ deviceId: cached }, "Resolved device ID from CADET_DEVICE_ID");
    return cached;
  }

  const { dir: cadetDir, file: filePath } = resolveDeviceIdPaths();
  const generated = randomUUID();

  try {
    const existing = readDeviceIdFromFile(filePath);
    if (existing) {
      cached = existing;
      log.info({ deviceId: cached }, "Resolved device ID from device.json");
      return cached;
    }
  } catch (err) {
    log.warn({ err }, "Failed to read device.json — generating new device ID");
  }

  // Either the file doesn't exist or deviceId was missing/empty.
  // Generate a new UUID and persist it.
  try {
    mkdirSync(cadetDir, { recursive: true });

    // Read existing content to preserve other fields
    let existing: Record<string, unknown> = {};
    try {
      if (existsSync(filePath)) {
        const raw = JSON.parse(readFileSync(filePath, "utf-8"));
        if (raw && typeof raw === "object" && !Array.isArray(raw)) {
          existing = raw as Record<string, unknown>;
        }
      }
    } catch {
      // Malformed JSON — start fresh
    }

    existing.deviceId = generated;
    writeFileSync(filePath, JSON.stringify(existing, null, 2) + "\n", {
      mode: 0o644,
    });
    log.info({ deviceId: generated }, "Created new device ID in device.json");
  } catch (err) {
    log.warn(
      { err },
      "Failed to write device.json — using generated device ID in-memory only",
    );
  }

  cached = generated;
  return cached;
}

/**
 * Reset the cached device ID. Used by tests to force
 * re-resolution on the next call.
 */
export function resetDeviceIdCache(): void {
  cached = undefined;
}
