/**
 * Unified secure key storage: single-backend routing through CredentialBackend
 * adapters.
 *
 * Backend selection (`resolveBackendAsync`) is the single async decision point:
 *   1. CES RPC (primary) — the CES record backend owns this process's session
 *      and reopens it when the transport dies.
 *
 * CES is purely a sibling process: it is the only credential store. When no
 * CES backend is ready, credentials report unreachable (callers fall back to
 * env vars); there is no local file fallback.
 */

import type { CesRpcClient as CesClient } from "@mycadet/ces-client/rpc-client";

import { ACP_OAUTH_TOKEN_FIELD, ACP_SERVICE } from "../acp/acp-credentials.js";
import { getAnyProviderEnvVar } from "../providers/provider-env-vars.js";
import { getLogger } from "../util/logger.js";
import { CesRpcCredentialBackend } from "./ces-rpc-credential-backend.js";
import { cesRecordBackend } from "./ces-rpc-record-backend.js";
import type {
  CredentialBackend,
  CredentialListResult,
  DeleteResult,
} from "./credential-backend.js";
import { createUnavailableBackend } from "./credential-backend.js";
import { credentialKey } from "./credential-key.js";

/**
 * Re-export shared-package secure-key abstractions so downstream consumers
 * can import from this module without a direct @mycadet/credential-storage
 * dependency.
 */

export interface SecureKeyResult {
  value: string | undefined;
  unreachable: boolean;
}

const log = getLogger("secure-keys");

let _resolvedBackend: CredentialBackend | undefined;
let _resolvePromise: Promise<CredentialBackend> | undefined;

/**
 * Test-only backend pin. When set, resolveBackendAsync() returns it directly,
 * bypassing CES routing — the same way a test process has no CES daemon to
 * reach. Prefer the `useMemorySecureKeys` test helper over calling this
 * directly.
 */
let _testingBackend: CredentialBackend | undefined;

export function setSecureKeyBackendForTesting(
  backend: CredentialBackend | undefined,
): void {
  _testingBackend = backend;
  _resolvedBackend = undefined;
  _resolvePromise = undefined;
}

/**
 * Hard timeout for each public credential operation (resolve + backend call).
 * Prevents indefinite blocking when CES reconnection or backend operations hang.
 */
const CREDENTIAL_OP_TIMEOUT_MS = 45_000;

/**
 * Returns the live CES RPC client, owned and reconnected by the record
 * backend. `undefined` until the first credential/record operation opens the
 * session.
 */
export function getCesClient(): CesClient | undefined {
  return cesRecordBackend.getClient();
}

/**
 * Resolve the primary credential backend for this process (async).
 *
 * The CES record backend owns this process's CES connection: it opens one
 * lazily on first use and reopens it whenever the transport dies, so
 * resolution either lands on the live CES RPC client or reports the store
 * unreachable (presence indeterminate — callers retry). A dead cached
 * backend is dropped and re-resolved on the next call; there is no local
 * file fallback.
 *
 * Call `_resetBackend()` in tests to clear the cached resolution.
 */
async function resolveBackendAsync(): Promise<CredentialBackend> {
  if (_testingBackend) {
    return _testingBackend;
  }
  if (_resolvedBackend?.isAvailable()) {
    return _resolvedBackend;
  }
  // Dead or absent — re-resolve. Reopening is single-flight, so back-to-back
  // ops share one connection attempt instead of hammering CES.
  _resolvedBackend = undefined;
  _resolvePromise = undefined;
  if (!_resolvePromise) {
    _resolvePromise = doResolveBackend().then((backend) => {
      // Never cache an unreachable result: the next credential op must
      // re-attempt CES rather than pinning an outage.
      if (backend.name !== "unavailable") {
        _resolvedBackend = backend;
      } else {
        _resolvePromise = undefined;
      }
      return backend;
    });
  }
  return _resolvePromise;
}

async function doResolveBackend(): Promise<CredentialBackend> {
  let client: CesClient | undefined;
  try {
    client = await cesRecordBackend.ensureClient();
  } catch (err) {
    log.info(
      { err },
      "CES is unreachable; reporting credentials as unreachable (indeterminate).",
    );
    return createUnavailableBackend();
  }
  if (client) {
    const cesRpc = new CesRpcCredentialBackend(client);
    if (cesRpc.isAvailable()) {
      log.info("Resolved credential backend: ces-rpc");
      return cesRpc;
    }
  }
  log.error(
    "No CES credential backend is ready; reporting credentials as unreachable (indeterminate).",
  );
  return createUnavailableBackend();
}

// ---------------------------------------------------------------------------
// Timeout helper
// ---------------------------------------------------------------------------

const CREDENTIAL_TIMEOUT_MSG = "Credential operation timed out";

/**
 * Race a credential operation against a hard deadline. If the operation
 * does not settle within `CREDENTIAL_OP_TIMEOUT_MS`, return the supplied
 * fallback value so callers degrade gracefully instead of hanging.
 *
 * Non-timeout errors from `op()` are propagated to callers rather than
 * silently swallowed — only genuine timeouts return the fallback.
 */
async function withCredentialTimeout<T>(
  op: () => Promise<T>,
  fallback: T,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      log.warn(CREDENTIAL_TIMEOUT_MSG + " — returning fallback");
      resolve(fallback);
    }, CREDENTIAL_OP_TIMEOUT_MS);

    op().then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * List all account names from the resolved backend (async).
 *
 * Queries exactly one backend — no cross-store merge.
 */
export async function listSecureKeysAsync(): Promise<CredentialListResult> {
  return withCredentialTimeout(
    async () => {
      const backend = await resolveBackendAsync();
      const result = await backend.list();
      return result;
    },
    { accounts: [], unreachable: true },
  );
}

// ---------------------------------------------------------------------------
// Async CRUD — single-backend routing
// ---------------------------------------------------------------------------

/**
 * Retrieve a secret from secure storage with richer result metadata.
 *
 * Returns both the value (if found) and whether the backend was
 * unreachable. Callers that need to distinguish "not found" from
 * "backend down" should use this instead of `getSecureKeyAsync`.
 *
 * Reads from exactly one backend — no cross-store fallback.
 */
export async function getSecureKeyResultAsync(
  account: string,
): Promise<SecureKeyResult> {
  return withCredentialTimeout(
    async () => {
      const backend = await resolveBackendAsync();
      const result = await backend.get(account);
      if (result.value != null) {
        return { value: result.value, unreachable: false };
      }
      return { value: undefined, unreachable: result.unreachable };
    },
    { value: undefined, unreachable: true },
  );
}

/**
 * Retrieve a secret from secure storage. Convenience wrapper over
 * `getSecureKeyResultAsync` that returns only the value.
 */
export async function getSecureKeyAsync(
  account: string,
): Promise<string | undefined> {
  const result = await getSecureKeyResultAsync(account);
  return result.value;
}

/**
 * Post-write side effects keyed on which credential was actually stored.
 *
 * Every path that lands a credential runs through this, single writes and bulk
 * restores alike, so a behaviour that has to follow a credential does not
 * depend on a list of call sites that drifts as write paths are added.
 *
 * Deliberately not where a Connect card is retired. A card is retired by the
 * marker it came from no longer matching the credential a spawn would resolve,
 * which is a comparison made when the marker is read. Nothing here has to fire
 * at the right moment for that to happen, so this is a notification rather
 * than a mechanism, and a failure costs freshness rather than correctness.
 *
 * Imported on demand and only on a match, so the ACP module graph stays out of
 * this module's load path.
 */
async function onCredentialsWritten(accounts: string[]): Promise<void> {
  if (!accounts.includes(credentialKey(ACP_SERVICE, ACP_OAUTH_TOKEN_FIELD))) {
    return;
  }
  try {
    // The Connect flow repairs the spawn policy *after* this write, so a token
    // whose read is still denied here is retried by `storeAcpClaudeToken` once
    // that repair lands. This pass covers every other writer.
    const { notifyAcpConnectRetired } =
      await import("../acp/acp-claude-oauth.js");
    await notifyAcpConnectRetired();
  } catch (err) {
    log.warn({ err }, "ACP Connect card notification failed after a write");
  }
}

/**
 * Store a secret in secure storage. Writes to exactly one backend, with no
 * dual-writing. Forces a CES reconnection when the backend is dead, because
 * callers (e.g. the post-login cloud credential push) do not retry a
 * failed write.
 */
export async function setSecureKeyAsync(
  account: string,
  value: string,
): Promise<boolean> {
  const ok = await withCredentialTimeout(async () => {
    const backend = await resolveBackendAsync();
    const stored = await backend.set(account, value);
    if (!stored) {
      log.warn(
        { account, backend: backend.name },
        "Credential backend set failed",
      );
    } else {
      log.info({ account, backend: backend.name }, "Credential stored");
    }
    return stored;
  }, false);
  // Detached, because it neither decides the result nor gates it. Under the
  // deadline its cost could turn a stored credential into a reported failure;
  // awaited after it, the cost merely held the caller at "signing in" while a
  // scan and a broadcast finished. Nothing downstream depends on it having
  // run: a card is retired by the marker comparison at read time, and the
  // credential prompt re-checks the registry entry before honouring it.
  if (ok) {
    void onCredentialsWritten([account]);
  }
  return ok;
}

/**
 * Delete a secret from secure storage.
 *
 * Deletes from exactly one backend — no cross-store cleanup.
 */
export async function deleteSecureKeyAsync(
  account: string,
): Promise<DeleteResult> {
  return withCredentialTimeout(async () => {
    const backend = await resolveBackendAsync();
    const result = await backend.delete(account);
    if (result === "deleted") {
      log.info({ account, backend: backend.name }, "Credential deleted");
    }
    return result;
  }, "error");
}

// ---------------------------------------------------------------------------
// Provider API key lookup — secure store + env var fallback
// ---------------------------------------------------------------------------

/**
 * Retrieve a provider API key, checking secure storage first and falling
 * back to the corresponding `<PROVIDER>_API_KEY` environment variable.
 *
 * Env var names are resolved via `getAnyProviderEnvVar`, which covers both
 * LLM providers (sourced from `PROVIDER_CATALOG`) and search providers
 * (sourced from `SEARCH_PROVIDER_ENV_VAR_NAMES`). Keyless providers (e.g.
 * Ollama) return `undefined` and fall through to a stored-only lookup.
 *
 * Use this instead of raw `getSecureKeyAsync` when looking up provider
 * API keys so that env-var-only setups continue to work.
 */
export async function getProviderKeyAsync(
  provider: string,
): Promise<string | undefined> {
  // Check credential namespace first; fall back to bare name for the brief
  // startup window before migration 002 has run.
  const stored =
    (await getSecureKeyAsync(credentialKey(provider, "api_key"))) ??
    (await getSecureKeyAsync(provider));
  if (stored) {
    return stored;
  }
  const envVar = getAnyProviderEnvVar(provider);
  return envVar ? process.env[envVar] : undefined;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Return the name of the currently resolved credential backend.
 * Useful for diagnostic messages when credential operations fail.
 */
export function getActiveBackendName(): string {
  return _resolvedBackend?.name ?? "none";
}

// ---------------------------------------------------------------------------
// Backend introspection
// ---------------------------------------------------------------------------

export type BackendInfo =
  | { backend: "ces-rpc"; ready: boolean }
  | { backend: "ces-http"; url: string }
  | { backend: "none" };

/**
 * Resolve the active credential backend (triggering resolution if not yet
 * done) and return introspection details specific to that backend.
 *
 * Useful for `credentials status` — shows which store this process is talking
 * to, so path/socket mismatches between the CLI and daemon are immediately
 * visible.
 */
export function getActiveBackendInfoAsync(): Promise<BackendInfo> {
  return withCredentialTimeout(
    async () => {
      const backend = await resolveBackendAsync();
      if (backend.name === "ces-rpc") {
        return { backend: "ces-rpc" as const, ready: backend.isAvailable() };
      }
      return { backend: "none" as const };
    },
    { backend: "none" as const },
  );
}

/** @internal Test-only: reset the cached backends so they're re-created. */
export function _resetBackend(): void {
  _resolvedBackend = undefined;
  _resolvePromise = undefined;
}
