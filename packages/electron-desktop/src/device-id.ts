/**
 * Device ID resolver for the Electron main process.
 *
 * Reads or creates a stable per-device UUID stored in device.json. The file
 * is shared with the daemon (TypeScript) and Swift client so all three
 * runtimes use the same identifier for X-Cadet-Client-Id headers.
 *
 * Path resolution mirrors CadetPaths.deviceIdFile (Swift) and
 * assistant/src/util/device-id.ts (daemon):
 *   - <configDir>/device.json where configDir is $XDG_CONFIG_HOME/cadet-<env>
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { resolveConfigDir, resolveEnvironmentName } from "@mycadet/local-mode";

let cached: string | undefined;

/**
 * Get the stable device ID for this machine.
 *
 * Resolution order:
 *   1. Cached in-memory value (populated on first call)
 *   2. deviceId field from device.json
 *   3. Generate a new UUID, persist it to device.json, and return it
 *
 * On any read/write error the generated UUID is still cached so the
 * process uses a consistent ID for the remainder of its lifetime.
 */
export function getDeviceId(): string {
  if (cached !== undefined) {
    return cached;
  }

  const dir = resolveConfigDir();
  const filePath = join(dir, "device.json");

  // Try to read an existing device.json, keeping the parsed object for
  // field preservation if we need to write back.
  let existing: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf-8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      existing = raw as Record<string, unknown>;
      if (
        typeof existing.deviceId === "string" &&
        existing.deviceId.length > 0
      ) {
        cached = existing.deviceId as string;
        return cached;
      }
    }
  } catch {
    // Missing or malformed — fall through to generate
  }

  // Generate a new UUID and persist it.
  const generated = randomUUID();
  try {
    mkdirSync(dir, { recursive: true });
    existing.deviceId = generated;
    writeFileSync(filePath, JSON.stringify(existing, null, 2) + "\n", {
      mode: 0o644,
    });
  } catch {
    // Write failed — use generated ID in-memory only
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
