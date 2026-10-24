/**
 * JWT token service for the gateway's auth system.
 *
 * Mirrors the assistant's token-service but manages its own signing key
 * using the same loadOrCreateSigningKey pattern. The key is stored at
 * {getGatewaySecurityDir()}/actor-token-signing-key.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { getLogger } from "../logger.js";
import { getGatewaySecurityDir, getWorkspaceDir } from "../paths.js";

import { isStaleEpoch } from "./policy.js";
import type { ScopeProfile, TokenAudience, TokenClaims } from "./types.js";

const log = getLogger("auth-token-service");

// ---------------------------------------------------------------------------
// Signing key management
// ---------------------------------------------------------------------------

let signingKey: Buffer | null = null;

export function getSigningKeyPath(): string {
  return join(getGatewaySecurityDir(), "actor-token-signing-key");
}

/**
 * Resolve the signing key for the gateway.
 *
 * Resolution order:
 *   1. ACTOR_TOKEN_SIGNING_KEY env var (hex-encoded, set by CLI for Docker)
 *   2. Load from disk (GATEWAY_SECURITY_DIR/actor-token-signing-key)
 *   3. Adopt the key the assistant's daemon era persisted under the
 *      workspace's transitional directory — the one-time migration for
 *      instances hatched before the gateway owned key custody. Consumed
 *      on read: the adopted key is persisted gateway-side and the old
 *      file removed.
 *   4. Generate a new key and persist to disk (local mode)
 */
export function loadOrCreateSigningKey(): Buffer {
  const envKey = process.env.ACTOR_TOKEN_SIGNING_KEY;
  if (envKey) {
    if (!/^[0-9a-f]{64}$/i.test(envKey)) {
      throw new Error(
        `Invalid ACTOR_TOKEN_SIGNING_KEY: expected 64 hex characters, got ${envKey.length} chars`,
      );
    }
    log.info("Signing key loaded from ACTOR_TOKEN_SIGNING_KEY env var");
    return Buffer.from(envKey, "hex");
  }

  const keyPath = getSigningKeyPath();

  if (existsSync(keyPath)) {
    try {
      const raw = readFileSync(keyPath);
      if (raw.length === 32) {
        log.info("Auth signing key loaded from disk");
        return raw;
      }
      log.warn("Signing key file has unexpected length, regenerating");
    } catch (err) {
      log.warn({ err }, "Failed to read signing key file, regenerating");
    }
  }

  const adopted = adoptLegacySigningKey(keyPath);
  if (adopted) {
    return adopted;
  }

  const newKey = randomBytes(32);
  persistSigningKey(keyPath, newKey);

  log.info("Auth signing key generated and persisted");
  return newKey;
}

/** The assistant daemon era's transitional key path (under its workspace). */
function legacySigningKeyPath(): string {
  return join(getWorkspaceDir(), "deprecated", "actor-token-signing-key");
}

/**
 * One-time adoption of the daemon-era key: a pre-custody instance holds
 * its identity only in the workspace's transitional file. Copy it into
 * gateway-security and consume the original, so the assistant container
 * stops having the signing key — this process is the sole holder now.
 * Returns undefined when there is nothing (or nothing valid) to adopt.
 */
function adoptLegacySigningKey(keyPath: string): Buffer | undefined {
  const legacyPath = legacySigningKeyPath();
  if (!existsSync(legacyPath)) {
    return undefined;
  }
  try {
    const raw = readFileSync(legacyPath);
    if (raw.length !== 32) {
      log.warn(
        { legacyPath },
        "Legacy signing key file has unexpected length, ignoring",
      );
      return undefined;
    }
    persistSigningKey(keyPath, raw);
    rmSync(legacyPath, { force: true });
    log.info(
      { legacyPath },
      "Adopted the daemon-era signing key into gateway security",
    );
    return raw;
  } catch (err) {
    log.warn({ err, legacyPath }, "Failed to adopt legacy signing key");
    return undefined;
  }
}

/** Atomic-write + chmod 0600 persistence into the gateway security dir. */
function persistSigningKey(keyPath: string, key: Buffer): void {
  const dir = dirname(keyPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tmpPath = keyPath + ".tmp." + process.pid;
  writeFileSync(tmpPath, key, { mode: 0o600 });
  renameSync(tmpPath, keyPath);
  chmodSync(keyPath, 0o600);
}

/**
 * Initialize (or reinitialize) the signing key. Called at gateway startup.
 */
export function initSigningKey(key: Buffer): void {
  signingKey = key;
}

function getSigningKey(): Buffer {
  if (!signingKey) {
    throw new Error(
      "Auth signing key not initialized — call initSigningKey() during startup",
    );
  }
  return signingKey;
}

// ---------------------------------------------------------------------------
// Base64url helpers
// ---------------------------------------------------------------------------

function base64urlEncode(data: Buffer | string): string {
  const buf = typeof data === "string" ? Buffer.from(data, "utf-8") : data;
  return buf.toString("base64url");
}

function base64urlDecode(str: string): Buffer {
  return Buffer.from(str, "base64url");
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type VerifyResult =
  | { ok: true; claims: TokenClaims }
  | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// JWT header
// ---------------------------------------------------------------------------

const JWT_HEADER = base64urlEncode(
  JSON.stringify({ alg: "HS256", typ: "JWT" }),
);

// ---------------------------------------------------------------------------
// Mint
// ---------------------------------------------------------------------------

export function mintToken(params: {
  aud: TokenAudience;
  sub: string;
  scope_profile: ScopeProfile;
  policy_epoch: number;
  ttlSeconds: number;
}): string {
  const now = Math.floor(Date.now() / 1000);
  const claims: TokenClaims = {
    iss: "cadet-auth",
    aud: params.aud,
    sub: params.sub,
    scope_profile: params.scope_profile,
    exp: now + params.ttlSeconds,
    policy_epoch: params.policy_epoch,
    iat: now,
    jti: randomBytes(16).toString("hex"),
  };

  const payload = base64urlEncode(JSON.stringify(claims));
  const sigInput = JWT_HEADER + "." + payload;
  const sig = createHmac("sha256", getSigningKey()).update(sigInput).digest();

  return sigInput + "." + base64urlEncode(sig);
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

export function verifyToken(
  token: string,
  expectedAud: TokenAudience,
  opts?: { allowExpired?: boolean },
): VerifyResult {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return {
      ok: false,
      reason: "malformed_token: expected 3 dot-separated parts",
    };
  }

  const [headerPart, payloadPart, sigPart] = parts;

  const sigInput = headerPart + "." + payloadPart;
  const expectedSig = createHmac("sha256", getSigningKey())
    .update(sigInput)
    .digest();
  const actualSig = base64urlDecode(sigPart);

  if (expectedSig.length !== actualSig.length) {
    return { ok: false, reason: "invalid_signature" };
  }

  if (!timingSafeEqual(expectedSig, actualSig)) {
    return { ok: false, reason: "invalid_signature" };
  }

  let claims: TokenClaims;
  try {
    const decoded = base64urlDecode(payloadPart).toString("utf-8");
    claims = JSON.parse(decoded) as TokenClaims;
  } catch {
    return { ok: false, reason: "malformed_claims" };
  }

  if (claims.aud !== expectedAud) {
    return {
      ok: false,
      reason: `audience_mismatch: expected ${expectedAud}, got ${claims.aud}`,
    };
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!opts?.allowExpired && claims.exp <= nowSeconds) {
    return { ok: false, reason: "token_expired" };
  }

  if (isStaleEpoch(claims.policy_epoch)) {
    return { ok: false, reason: "stale_policy_epoch" };
  }

  return { ok: true, claims };
}
