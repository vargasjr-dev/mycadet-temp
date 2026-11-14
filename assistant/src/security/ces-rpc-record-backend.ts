/**
 * CES RPC backend for non-secret credential records (identity + policy).
 *
 * The backend owns one CES IPC connection: discover `ces.sock`, connect,
 * handshake. It is not a process manager — the CES process itself is owned by
 * the CLI (sibling) or the pod infrastructure (managed); this is only a
 * client. CES is expected to be up and reachable once the assistant reports
 * ready, so operations do not retry here: an unreachable CES throws and the
 * caller surfaces the failure (the credentials routes map it to a 503; the
 * CLI owns any retry).
 */

import { CesRpcClient as CesClient } from "@mycadet/ces-client/rpc-client";
import type { CredentialRecord } from "@mycadet/service-contracts/credential-rpc";
import { CesRpcMethod } from "@mycadet/service-contracts/credential-rpc";

import type { CesSessionClient } from "../credential-execution/client.js";
import { createCesClient } from "../credential-execution/client.js";
import { CesUnavailableError } from "../credential-execution/process-manager.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("ces-rpc-record-backend");

/** Minimum interval between CES connection attempts after a failure. */
const LAZY_SESSION_COOLDOWN_MS = 3_000;

/** How long ensureClient waits on a self-healing session before giving up. */
const RECONNECT_WAIT_MS = 15_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class CesRpcRecordBackend {
  /**
   * The live IPC session, opened by this backend's first record operation.
   * The session owns its transport and reconnection: after a CES restart the
   * same reference becomes ready again, so this backend never re-opens or
   * swaps clients itself.
   */
  private client: CesSessionClient | undefined;

  /** Memoized in-flight session attempt (single-flight across callers). */
  private sessionAttempt: Promise<CesClient> | undefined;

  /** When the last connection attempt failed; gates re-attempts. */
  private lastFailedAttemptAt = 0;

  /** Sync snapshot of the live client; `undefined` until connected. */
  getClient(): CesClient | undefined {
    return this.client?.isReady() ? this.client : undefined;
  }

  /**
   * Resolve the client, opening our own CES IPC connection on first use.
   * Throws {@link CesUnavailableError} when CES is unreachable — callers
   * surface that rather than degrading, so a lost write is never mistaken
   * for a successful one. Failed attempts are not re-attempted within the
   * cooldown window: every operation would otherwise re-pay the discovery
   * polling while CES is down. A held session whose transport died is NOT
   * dropped here — the session reconnects itself; we just wait for it.
   */
  async ensureClient(): Promise<CesClient> {
    if (this.client?.isReady()) {
      return this.client;
    }
    if (this.client && !this.client.isReady()) {
      // The session is self-healing (in-session reconnect loop) — wait for
      // it to come back rather than opening a competing session.
      for (let waited = 0; waited < RECONNECT_WAIT_MS; waited += 250) {
        await sleep(250);
        if (this.client.isReady()) {
          return this.client;
        }
      }
      throw new CesUnavailableError(
        "CES is unreachable (session reconnect did not become ready)",
      );
    }
    if (Date.now() - this.lastFailedAttemptAt < LAZY_SESSION_COOLDOWN_MS) {
      throw new CesUnavailableError(
        "CES is unreachable (recent connection attempt failed)",
      );
    }
    if (!this.sessionAttempt) {
      this.sessionAttempt = createCesClient()
        .then((client) => {
          if (!client) {
            throw new CesUnavailableError(
              "CES is unreachable (socket discovery failed or handshake rejected)",
            );
          }
          this.client = client;
          return client;
        })
        .catch((err) => {
          this.lastFailedAttemptAt = Date.now();
          throw err;
        })
        .finally(() => {
          this.sessionAttempt = undefined;
        });
    }
    return this.sessionAttempt;
  }

  /** Close the backend's connection (one-shot CLI processes call this on exit). */
  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.sessionAttempt = undefined;
    // A deliberate close is a fresh start: clear any open-failure cooldown.
    this.lastFailedAttemptAt = 0;
    await client?.stop().catch(() => {});
  }

  isAvailable(): boolean {
    return this.client?.isReady() ?? false;
  }

  async set(account: string, record: CredentialRecord): Promise<boolean> {
    const client = await this.ensureClient();
    const result = await client.call(CesRpcMethod.SetCredentialRecord, {
      account,
      record,
    });
    return result.ok;
  }

  async delete(account: string): Promise<"deleted" | "not-found"> {
    const client = await this.ensureClient();
    const result = await client.call(CesRpcMethod.DeleteCredentialRecord, {
      account,
    });
    if (result.result === "error") {
      throw new CesUnavailableError(
        `CES failed to delete the credential record for ${account}`,
      );
    }
    return result.result;
  }

  /**
   * Live catalog listing, or `null` when CES is unreachable. Reads keep the
   * degraded-result convention: an outage must not look like an empty vault,
   * so `null` is the caller's "indeterminate" signal rather than an error.
   */
  async list(): Promise<Array<{
    account: string;
    record: CredentialRecord;
  }> | null> {
    try {
      const client = await this.ensureClient();
      const result = await client.call(CesRpcMethod.ListCredentialRecords, {});
      return result.records ?? [];
    } catch (err) {
      log.warn({ err }, "CES RPC credential record list failed");
      return null;
    }
  }
}

/**
 * Production record backend singleton. Always constructed — credential
 * metadata operations always have a backend to talk to, and every process
 * (daemon included) lazily opens its own CES connection through it.
 */
export const cesRecordBackend = new CesRpcRecordBackend();
