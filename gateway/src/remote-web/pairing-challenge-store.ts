import { createHash, randomBytes, randomInt } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { getGatewaySecurityDir } from "../paths.js";

import {
  REMOTE_WEB_PAIRING_CODE_TTL_MS,
  type RemoteWebPairingChallengeResponse,
  type RemoteWebPairingRequestSummary,
  type RemoteWebPairingTokenPendingResponse,
  type RemoteWebPairingVerificationResponse,
} from "@mycadet/service-contracts/remote-web-pairing";

const CODE_TTL_MS = REMOTE_WEB_PAIRING_CODE_TTL_MS;
const MAX_ACTIVE_CHALLENGES = 200;
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const USER_CODE_LENGTH = 8;
const DEVICE_CODE_BYTES = 32;
const POLL_INTERVAL_SECONDS = 5;

export interface PendingRemoteWebPairingChallenge {
  id: string;
  deviceCodeHash: string;
  userCodeHash: string;
  // Deliberately plaintext: the loopback-gated list route shows it to the
  // host approver. The hash fields remain the lookup keys.
  userCode: string;
  publicBaseUrl: string;
  verificationUri: string;
  status: "pending" | "approved" | "exchanging" | "consumed";
  createdAtMs: number;
  expiresAtMs: number;
  requesterIp: string;
  requesterUserAgent: string | null;
  viaEdgeProxy: boolean;
  approvedAtMs?: number;
  exchangeStartedAtMs?: number;
  consumedAtMs?: number;
}

export interface RemoteWebPairingChallengeCapacityLimit {
  retryAfterSeconds: number;
}

export type ApproveRemoteWebPairingChallengeResult =
  | RemoteWebPairingVerificationResponse
  | { status: "expired" }
  | { status: "invalid" };

export type ClaimRemoteWebPairingChallengeExchangeResult =
  | {
      status: "approved";
      publicBaseUrl: string;
      verificationUri: string;
      expiresAt: string;
    }
  | RemoteWebPairingTokenPendingResponse
  | { status: "expired" }
  | { status: "consumed" }
  | { status: "invalid" };

const challengesByUserCodeHash = new Map<
  string,
  PendingRemoteWebPairingChallenge
>();
const challengesByDeviceCodeHash = new Map<
  string,
  PendingRemoteWebPairingChallenge
>();
let nowForTests: (() => number) | null = null;

function nowMs(): number {
  return nowForTests?.() ?? Date.now();
}

/**
 * The challenge store is FILE-BACKED under GATEWAY_SECURITY_DIR so a mint can
 * run in ANY process: `gateway pairing mint` executes the mint logic directly
 * (deliberately never over the gateway's IPC socket — the assistant daemon
 * shares that socket, and an IPC-exposed mint would let the assistant
 * approve pairings for itself) and persists the challenge here. The running
 * gateway's verification and token-exchange routes re-read the file on every
 * store call, so cross-process writes land. Writes are atomic (tmp + rename)
 * and the single-user local flow makes last-writer-wins races a non-issue.
 */
const STORE_FILENAME = "remote-web-pairing-challenges.json";

let lastResolvedStorePath: string | null = null;

function challengeStoreFilePath(): string {
  const resolved = join(getGatewaySecurityDir(), STORE_FILENAME);
  lastResolvedStorePath = resolved;
  return resolved;
}

function isNotExistError(err: unknown): boolean {
  return err instanceof Error && "code" in err && err.code === "ENOENT";
}

function isChallengeLike(
  value: unknown,
): value is PendingRemoteWebPairingChallenge {
  return (
    typeof value === "object" &&
    value !== null &&
    "userCodeHash" in value &&
    typeof value.userCodeHash === "string" &&
    "deviceCodeHash" in value &&
    typeof value.deviceCodeHash === "string"
  );
}

/**
 * Re-sync the in-memory maps from disk at the top of every exported call.
 * A missing file is an empty store; a corrupt one warns and starts empty.
 * Expired challenges are NOT dropped here — the same cleanup/expiry checks
 * that ran before file-backing still classify them ("expired", not
 * "invalid") and delete them on their own paths.
 */
function loadFromDisk(): void {
  challengesByUserCodeHash.clear();
  challengesByDeviceCodeHash.clear();

  let raw: string;
  try {
    raw = readFileSync(challengeStoreFilePath(), "utf-8");
  } catch (err) {
    if (isNotExistError(err)) return;
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (!Array.isArray(parsed)) {
    console.warn(
      `[pairing-challenge-store] could not read ${challengeStoreFilePath()} — starting empty.`,
    );
    return;
  }
  for (const entry of parsed) {
    if (!isChallengeLike(entry)) continue;
    challengesByUserCodeHash.set(entry.userCodeHash, entry);
    challengesByDeviceCodeHash.set(entry.deviceCodeHash, entry);
  }
}

/** Persist the current challenges so other processes can see them. */
function saveToDisk(): void {
  const filePath = challengeStoreFilePath();
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(
    tmpPath,
    JSON.stringify([...challengesByUserCodeHash.values()]),
    { mode: 0o600 },
  );
  renameSync(tmpPath, filePath);
}

function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function randomUserCode(): string {
  let code = "";
  for (let i = 0; i < USER_CODE_LENGTH; i++) {
    code += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function normalizeUserCode(code: string): string {
  return code.replace(/[^A-Z0-9]/gi, "").toUpperCase();
}

function deleteChallenge(challenge: PendingRemoteWebPairingChallenge): void {
  challengesByUserCodeHash.delete(challenge.userCodeHash);
  challengesByDeviceCodeHash.delete(challenge.deviceCodeHash);
}

function cleanupExpiredChallenges(now = nowMs()): void {
  for (const challenge of challengesByUserCodeHash.values()) {
    if (challenge.expiresAtMs <= now) {
      deleteChallenge(challenge);
    }
  }
}

export function checkRemoteWebPairingChallengeCapacity(): RemoteWebPairingChallengeCapacityLimit | null {
  loadFromDisk();
  const now = nowMs();
  cleanupExpiredChallenges(now);

  if (challengesByUserCodeHash.size < MAX_ACTIVE_CHALLENGES) return null;

  let earliestExpiresAtMs = Number.POSITIVE_INFINITY;
  for (const challenge of challengesByUserCodeHash.values()) {
    earliestExpiresAtMs = Math.min(earliestExpiresAtMs, challenge.expiresAtMs);
  }

  return {
    retryAfterSeconds: Math.max(
      1,
      Math.ceil((earliestExpiresAtMs - now) / 1000),
    ),
  };
}

export function createRemoteWebPairingChallenge(
  publicBaseUrl: string,
  requester: { ip: string; userAgent: string | null; viaEdgeProxy: boolean },
): RemoteWebPairingChallengeResponse {
  loadFromDisk();
  cleanupExpiredChallenges();

  const deviceCode = randomBytes(DEVICE_CODE_BYTES).toString("base64url");
  const deviceCodeHash = hashSecret(deviceCode);
  let userCode = randomUserCode();
  let userCodeHash = hashSecret(normalizeUserCode(userCode));
  while (challengesByUserCodeHash.has(userCodeHash)) {
    userCode = randomUserCode();
    userCodeHash = hashSecret(normalizeUserCode(userCode));
  }

  const verificationUri = `${publicBaseUrl}/assistant/pair`;
  const createdAtMs = nowMs();
  const expiresAtMs = createdAtMs + CODE_TTL_MS;
  const challenge: PendingRemoteWebPairingChallenge = {
    id: randomBytes(16).toString("base64url"),
    deviceCodeHash,
    userCodeHash,
    userCode,
    publicBaseUrl,
    verificationUri,
    status: "pending",
    createdAtMs,
    expiresAtMs,
    requesterIp: requester.ip,
    requesterUserAgent: requester.userAgent,
    viaEdgeProxy: requester.viaEdgeProxy,
  };
  challengesByUserCodeHash.set(userCodeHash, challenge);
  challengesByDeviceCodeHash.set(deviceCodeHash, challenge);
  saveToDisk();

  return {
    deviceCode,
    userCode,
    verificationUri,
    expiresAt: new Date(expiresAtMs).toISOString(),
    expiresInSeconds: Math.ceil(CODE_TTL_MS / 1000),
    intervalSeconds: POLL_INTERVAL_SECONDS,
  };
}

function approveChallenge(
  challenge: PendingRemoteWebPairingChallenge,
): ApproveRemoteWebPairingChallengeResult {
  if (challenge.status === "exchanging" || challenge.status === "consumed") {
    return { status: "invalid" };
  }

  const now = nowMs();
  if (challenge.expiresAtMs <= now) {
    deleteChallenge(challenge);
    return { status: "expired" };
  }

  challenge.status = "approved";
  challenge.approvedAtMs = now;
  return {
    status: "approved",
    verificationUri: challenge.verificationUri,
    expiresAt: new Date(challenge.expiresAtMs).toISOString(),
  };
}

export function approveRemoteWebPairingChallenge(
  userCode: string,
): ApproveRemoteWebPairingChallengeResult {
  loadFromDisk();
  const userCodeHash = hashSecret(normalizeUserCode(userCode));
  const challenge = challengesByUserCodeHash.get(userCodeHash);
  if (!challenge) {
    return { status: "invalid" };
  }
  const result = approveChallenge(challenge);
  saveToDisk();
  return result;
}

function findChallengeById(
  id: string,
): PendingRemoteWebPairingChallenge | undefined {
  for (const challenge of challengesByUserCodeHash.values()) {
    if (challenge.id === id) {
      return challenge;
    }
  }
  return undefined;
}

export function listPendingRemoteWebPairingChallenges(): RemoteWebPairingRequestSummary[] {
  loadFromDisk();
  cleanupExpiredChallenges();

  const pending = [...challengesByUserCodeHash.values()]
    .filter((challenge) => challenge.status === "pending")
    .sort((a, b) => b.createdAtMs - a.createdAtMs);

  return pending.map((challenge) => ({
    requestId: challenge.id,
    userCode: challenge.userCode,
    publicBaseUrl: challenge.publicBaseUrl,
    requestedAt: new Date(challenge.createdAtMs).toISOString(),
    expiresAt: new Date(challenge.expiresAtMs).toISOString(),
    requesterIp: challenge.requesterIp,
    requesterUserAgent: challenge.requesterUserAgent,
    viaEdgeProxy: challenge.viaEdgeProxy,
  }));
}

export function approveRemoteWebPairingChallengeById(
  id: string,
): ApproveRemoteWebPairingChallengeResult {
  loadFromDisk();
  const challenge = findChallengeById(id);
  if (!challenge) {
    return { status: "invalid" };
  }
  const result = approveChallenge(challenge);
  saveToDisk();
  return result;
}

export type DenyRemoteWebPairingChallengeResult =
  | { status: "denied" }
  | { status: "already_approved" }
  | { status: "invalid" };

export function denyRemoteWebPairingChallengeById(
  id: string,
): DenyRemoteWebPairingChallengeResult {
  loadFromDisk();
  const challenge = findChallengeById(id);
  if (!challenge) {
    return { status: "invalid" };
  }
  // Approved/exchanging/consumed: the remote device may already be pairing.
  // Distinct from unknown-id so the route can surface it instead of a 404 the
  // client would read as an already-handled row.
  if (challenge.status !== "pending") {
    return { status: "already_approved" };
  }

  deleteChallenge(challenge);
  saveToDisk();
  return { status: "denied" };
}

export function claimRemoteWebPairingChallengeExchange(
  deviceCode: string,
): ClaimRemoteWebPairingChallengeExchangeResult {
  loadFromDisk();
  const deviceCodeHash = hashSecret(deviceCode);
  const challenge = challengesByDeviceCodeHash.get(deviceCodeHash);
  if (!challenge) return { status: "invalid" };

  const now = nowMs();
  if (challenge.expiresAtMs <= now) {
    deleteChallenge(challenge);
    saveToDisk();
    return { status: "expired" };
  }

  if (challenge.status === "pending") {
    return {
      status: "pending",
      expiresAt: new Date(challenge.expiresAtMs).toISOString(),
      intervalSeconds: POLL_INTERVAL_SECONDS,
    };
  }
  if (challenge.status === "exchanging") {
    return {
      status: "pending",
      expiresAt: new Date(challenge.expiresAtMs).toISOString(),
      intervalSeconds: POLL_INTERVAL_SECONDS,
    };
  }
  if (challenge.status === "consumed") return { status: "consumed" };

  challenge.status = "exchanging";
  challenge.exchangeStartedAtMs = now;
  saveToDisk();
  return {
    status: "approved",
    publicBaseUrl: challenge.publicBaseUrl,
    verificationUri: challenge.verificationUri,
    expiresAt: new Date(challenge.expiresAtMs).toISOString(),
  };
}

export function completeRemoteWebPairingChallengeExchange(
  deviceCode: string,
): void {
  loadFromDisk();
  const challenge = challengesByDeviceCodeHash.get(hashSecret(deviceCode));
  if (!challenge || challenge.status !== "exchanging") return;

  challenge.status = "consumed";
  challenge.consumedAtMs = nowMs();
  saveToDisk();
}

export function releaseRemoteWebPairingChallengeExchange(
  deviceCode: string,
): void {
  loadFromDisk();
  const challenge = challengesByDeviceCodeHash.get(hashSecret(deviceCode));
  if (!challenge || challenge.status !== "exchanging") return;

  challenge.status = "approved";
  challenge.exchangeStartedAtMs = undefined;
  saveToDisk();
}

export function resetRemoteWebPairingChallengesForTests(): void {
  challengesByUserCodeHash.clear();
  challengesByDeviceCodeHash.clear();
  nowForTests = null;
  // Best effort on the LAST-RESOLVED path: test files may delete
  // GATEWAY_SECURITY_DIR before this runs, and re-resolving then would
  // either throw the ephemeral-path guard or point at the wrong dir.
  if (lastResolvedStorePath) {
    try {
      rmSync(lastResolvedStorePath, { force: true });
    } catch {
      /* the maps are cleared either way */
    }
  }
}

export function setRemoteWebPairingChallengeNowForTests(
  now: () => number,
): void {
  nowForTests = now;
}

export function getRemoteWebPairingChallengeForTests(
  userCode: string,
): PendingRemoteWebPairingChallenge | undefined {
  loadFromDisk();
  return challengesByUserCodeHash.get(hashSecret(normalizeUserCode(userCode)));
}
