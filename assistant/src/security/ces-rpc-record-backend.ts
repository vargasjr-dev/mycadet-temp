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

import { openCesRpcSession } from "../credential-execution/ces-connect.js";
import type { CesSessionClient } from "../credential-execution/client.js";
import { CesUnavailableError } from "../credential-execution/process-manager.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("ces-rpc-record-backend");

/** Minimum interval between CES connection attempts after a failure. */
const LAZY_SESSION_COOLDOWN_MS = 3_000;

class CesRpcRecordBackend {
  /**
   * The live IPC client, opened by this backend's first record operation and
   * reopened on the next operation whenever the transport dies.
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
   * polling while CES is down.
   */
  async ensureClient(): Promise<CesClient> {
    if (this.client?.isReady()) {
      return this.client;
    }
    // Stale client from a dead transport — drop it and re-open below.
    this.client = undefined;
    if (Date.now() - this.lastFailedAttemptAt < LAZY_SESSION_COOLDOWN_MS) {
      throw new CesUnavailableError(
        "CES is unreachable (recent connection attempt failed)",
      );
    }
    if (!this.sessionAttempt) {
      this.sessionAttempt = openCesRpcSession()
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
