/**
 * CES RPC backend for non-secret credential records (identity + policy).
 */

import { CesRpcClient as CesClient } from "@mycadet/ces-client/rpc-client";
import type { CredentialRecord } from "@mycadet/service-contracts/credential-rpc";
import { CesRpcMethod } from "@mycadet/service-contracts/credential-rpc";

import { openCesRpcSession } from "../credential-execution/ces-connect.js";
import type { CesProcessManager } from "../credential-execution/process-manager.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("ces-rpc-record-backend");

/** Minimum interval between lazy CES session attempts after a failure. */
const LAZY_SESSION_COOLDOWN_MS = 3_000;

class CesRpcRecordBackend {
  /**
   * The live CES client, opened by this backend's first record operation and
   * reopened (cooldown-gated) whenever the transport dies.
   */
  private client: CesClient | undefined;
  private sessionProcessManager: CesProcessManager | undefined;

  /** Memoized in-flight session attempt. */
  private sessionAttempt: Promise<CesClient | undefined> | undefined;
  private lastFailedAttemptAt = 0;

  /** Sync snapshot of the live client; `undefined` until the first operation. */
  getClient(): CesClient | undefined {
    return this.client?.isReady() ? this.client : undefined;
  }

  /**
   * Resolve the client to use, opening (and keeping) our own CES session on
   * first use. A failed attempt is retried at most once per cooldown window
   * so a missing CES degrades quickly instead of wedging; a session that
   * later dies reopens on the next operation (no cooldown — the failure
   * cooldown only gates attempts that never produced a client).
   */
  async ensureClient(): Promise<CesClient | undefined> {
    if (this.client?.isReady()) {
      return this.client;
    }
    // Stale client from a dead transport — drop it and re-open below.
    this.client = undefined;
    if (this.sessionAttempt) {
      return this.sessionAttempt;
    }
    if (Date.now() - this.lastFailedAttemptAt < LAZY_SESSION_COOLDOWN_MS) {
      return undefined;
    }
    const attempt = openCesRpcSession()
      .then((session) => {
        if (!session) {
          return undefined;
        }
        this.client = session.client;
        this.sessionProcessManager = session.processManager;
        return session.client;
      })
      .catch((err) => {
        log.warn({ err }, "CES RPC lazy session open failed");
        return undefined;
      })
      .finally(() => {
        if (this.sessionAttempt === attempt) {
          this.sessionAttempt = undefined;
        }
      });
    this.sessionAttempt = attempt;
    const client = await attempt;
    if (!client) {
      this.lastFailedAttemptAt = Date.now();
    }
    return client;
  }

  /** Close the backend's session (one-shot CLI processes call this on exit). */
  async close(): Promise<void> {
    const client = this.client;
    const pm = this.sessionProcessManager;
    this.client = undefined;
    this.sessionAttempt = undefined;
    this.sessionProcessManager = undefined;
    // A deliberate close is a fresh start: clear any open-failure cooldown.
    this.lastFailedAttemptAt = 0;
    client?.close();
    await pm?.stop().catch(() => {});
  }

  isAvailable(): boolean {
    return this.client?.isReady() ?? false;
  }

  async get(account: string): Promise<CredentialRecord | undefined> {
    const client = await this.ensureClient();
    if (!client) {
      return undefined;
    }
    try {
      const result = await client.call(CesRpcMethod.GetCredentialRecord, {
        account,
      });
      return result.found ? result.record : undefined;
    } catch (err) {
      log.warn({ err, account }, "CES RPC credential record get failed");
      return undefined;
    }
  }

  async set(account: string, record: CredentialRecord): Promise<boolean> {
    const client = await this.ensureClient();
    if (!client) {
      return false;
    }
    try {
      const result = await client.call(CesRpcMethod.SetCredentialRecord, {
        account,
        record,
      });
      return result.ok;
    } catch (err) {
      log.warn({ err, account }, "CES RPC credential record set failed");
      return false;
    }
  }

  async delete(account: string): Promise<"deleted" | "not-found" | "error"> {
    const client = await this.ensureClient();
    if (!client) {
      return "error";
    }
    try {
      const result = await client.call(CesRpcMethod.DeleteCredentialRecord, {
        account,
      });
      return result.result;
    } catch (err) {
      log.warn({ err, account }, "CES RPC credential record delete failed");
      return "error";
    }
  }

  async list(): Promise<Array<{
    account: string;
    record: CredentialRecord;
  }> | null> {
    const client = await this.ensureClient();
    if (!client) {
      return null;
    }
    try {
      const result = await client.call(CesRpcMethod.ListCredentialRecords, {});
      return result.records ?? [];
    } catch (err) {
      log.warn({ err }, "CES RPC credential record list failed");
      return null;
    }
  }

  async bulkSet(
    records: Array<{ account: string; record: CredentialRecord }>,
  ): Promise<Array<{ account: string; ok: boolean }>> {
    const client = await this.ensureClient();
    if (!client) {
      return records.map((entry) => ({ account: entry.account, ok: false }));
    }
    try {
      const result = await client.call(CesRpcMethod.BulkSetCredentialRecords, {
        records,
      });
      return result.results;
    } catch (err) {
      log.warn({ err }, "CES RPC credential record bulk set failed");
      return records.map((entry) => ({ account: entry.account, ok: false }));
    }
  }
}

/**
 * Production record backend singleton. Always constructed — credential
 * metadata operations always have a backend to talk to, and every process
 * (daemon included) lazily opens its own CES session through it.
 */
export const cesRecordBackend = new CesRpcRecordBackend();
