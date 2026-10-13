/**
 * Creation-rate limit for remote-web pairing challenges — 20 per minute,
 * FILE-BACKED under GATEWAY_SECURITY_DIR so every minting process counts
 * against the same window: the `gateway pairing mint` CLI runs in its own
 * process (never over the gateway's IPC socket — the assistant daemon shares
 * that socket), and the gateway's HTTP mint route runs in the server
 * process. A per-process window would be meaningless for the CLI (a fresh
 * process per mint), so the timestamps persist to disk and every call
 * re-reads them.
 */

import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { getGatewaySecurityDir } from "../paths.js";

const RATE_LIMIT_MAX_CHALLENGES = 20;
const RATE_LIMIT_WINDOW_MS = 60_000;
const STORE_FILENAME = "remote-web-pairing-creation-rate.json";

export interface RemoteWebPairingChallengeRateLimit {
  retryAfterSeconds: number;
}

const challengeCreationTimestamps: number[] = [];

let lastResolvedStorePath: string | null = null;

function rateLimitStoreFilePath(): string {
  const resolved = join(getGatewaySecurityDir(), STORE_FILENAME);
  lastResolvedStorePath = resolved;
  return resolved;
}

function isNotExistError(err: unknown): boolean {
  return err instanceof Error && "code" in err && err.code === "ENOENT";
}

/** Re-sync the timestamps from disk; a missing file is an empty window. */
function loadFromDisk(): void {
  challengeCreationTimestamps.length = 0;

  let raw: string;
  try {
    raw = readFileSync(rateLimitStoreFilePath(), "utf-8");
  } catch (err) {
    if (isNotExistError(err)) return;
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn(
      `[pairing-challenge-rate-limit] could not read ${rateLimitStoreFilePath()} — starting empty.`,
    );
    return;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("timestamps" in parsed) ||
    !Array.isArray(parsed.timestamps)
  ) {
    return;
  }
  for (const timestamp of parsed.timestamps) {
    if (typeof timestamp === "number") {
      challengeCreationTimestamps.push(timestamp);
    }
  }
}

/** Persist the current window atomically so other processes see it. */
function saveToDisk(): void {
  const filePath = rateLimitStoreFilePath();
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(
    tmpPath,
    JSON.stringify({ timestamps: [...challengeCreationTimestamps] }),
    { mode: 0o600 },
  );
  renameSync(tmpPath, filePath);
}

export function recordRemoteWebPairingChallengeCreation(): RemoteWebPairingChallengeRateLimit | null {
  loadFromDisk();
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;

  while (
    challengeCreationTimestamps.length > 0 &&
    challengeCreationTimestamps[0] <= windowStart
  ) {
    challengeCreationTimestamps.shift();
  }

  if (challengeCreationTimestamps.length >= RATE_LIMIT_MAX_CHALLENGES) {
    const resetAtMs = challengeCreationTimestamps[0] + RATE_LIMIT_WINDOW_MS;
    return {
      retryAfterSeconds: Math.max(1, Math.ceil((resetAtMs - now) / 1000)),
    };
  }

  challengeCreationTimestamps.push(now);
  saveToDisk();
  return null;
}

export function resetRemoteWebPairingChallengeRateLimiterForTests(): void {
  challengeCreationTimestamps.length = 0;
  // Best effort on the LAST-RESOLVED path — see the challenge store's note.
  if (lastResolvedStorePath) {
    try {
      rmSync(lastResolvedStorePath, { force: true });
    } catch {
      /* the timestamps are cleared either way */
    }
  }
}
