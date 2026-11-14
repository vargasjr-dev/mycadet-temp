/**
 * CES RPC backend for non-secret credential records (identity + policy).
 *
 * The backend OWNS its CES client. The assistant daemon shares its already
 * connected session via {@link CesRpcRecordBackend.setClient} (set on every
 * `setCesClient()` — including reconnects); every other process (CLI, plugin
 * and worker subprocesses) opens its own CES RPC session lazily on the first
 * record operation, memoized with a retry cooldown so a missing CES never
 * wedges an operation.
 *
 * The module singleton {@link cesRecordBackend} is the production record
 * backend — it is constructed at import time and never replaced.
 */

import { CesRpcClient as CesClient } from "@mycadet/ces-client/rpc-client";
import type { CredentialRecord } from "@mycadet/service-contracts/credential-rpc";
import { CesRpcMethod } from "@mycadet/service-contracts/credential-rpc";

import { openCesRpcSession } from "../credential-execution/ces-connect.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("ces-rpc-record-backend");

export interface CredentialRecordBackend {
  /**
   * Transport id. `"ces-rpc"` is the attached CES socket backend; live
   * catalog listing fails over to CES HTTP when that transport is down.
   */
  readonly name?: string;
  isAvailable(): boolean;
  get(account: string): Promise<CredentialRecord | undefined>;
  set(account: string, record: CredentialRecord): Promise<boolean>;
  delete(account: string): Promise<"deleted" | "not-found" | "error">;
  /**
   * List all records. Returns `null` when CES cannot be reached so callers
   * can distinguish an outage from an empty catalog.
   */
  list(): Promise<Array<{
    account: string;
    record: CredentialRecord;
  }> | null>;
  bulkSet(
    records: Array<{ account: string; record: CredentialRecord }>,
  ): Promise<Array<{ account: string; ok: boolean }>>;
}

/** Minimum interval between lazy CES session attempts after a failure. */
const LAZY_SESSION_COOLDOWN_MS = 3_000;

class CesRpcRecordBackend implements CredentialRecordBackend {
  readonly name = "ces-rpc";

  /**
   * The live CES client. Set via {@link setClient} when a process already
   * owns a session (assistant boot/reconnect), or by the first lazy
   * {@link readyClient} call in child processes.
   */
  private client: CesClient | undefined;

  /** Memoized lazy session attempt (child-process self-connect). */
  private lazySession: Promise<CesClient | undefined> | undefined;
  private lastLazyAttemptAt = 0;

  /**
   * Test-only delegate. When set, every operation forwards to it and the
   * real CES client is ignored.
   */
  private testDelegate: CredentialRecordBackend | undefined;

  /**
   * Share an existing CES session. Called by `setCesClient()` so the daemon
   * (and its reconnects) keep one session; `undefined` detaches and the
   * backend falls back to lazy self-connection.
   */
  setClient(client: CesClient | undefined): void {
    this.client = client;
    this.lazySession = undefined;
    this.lastLazyAttemptAt = 0;
  }

  /** Test-only: forward every operation to `delegate` until cleared. */
  useTestDelegate(delegate: CredentialRecordBackend | undefined): void {
    this.testDelegate = delegate;
  }

  isAvailable(): boolean {
    if (this.testDelegate) {
      try {
        return this.testDelegate.isAvailable();
      } catch {
        return false;
      }
    }
    return this.client?.isReady() ?? false;
  }

  /**
   * Resolve the client to use. Injected session wins; otherwise open (and
   * keep) our own CES session. A failed attempt is retried at most once per
   * cooldown window so a missing CES degrades quickly instead of wedging.
   */
  private async readyClient(): Promise<CesClient | undefined> {
    if (this.testDelegate) {
      return undefined;
    }
    if (this.client?.isReady()) {
      return this.client;
    }
    if (
      this.lazySession &&
      Date.now() - this.lastLazyAttemptAt < LAZY_SESSION_COOLDOWN_MS
    ) {
      return this.lazySession;
    }
    this.lastLazyAttemptAt = Date.now();
    this.lazySession = openCesRpcSession()
      .then((session) => {
        if (!session) {
          this.lazySession = undefined;
          return undefined;
        }
        this.client = session.client;
        return session.client;
      })
      .catch((err) => {
        log.warn({ err }, "CES RPC lazy session open failed");
        this.lazySession = undefined;
        return undefined;
      });
    return this.lazySession;
  }

  async get(account: string): Promise<CredentialRecord | undefined> {
    if (this.testDelegate) {
      return this.testDelegate.get(account);
    }
    const client = await this.readyClient();
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
    if (this.testDelegate) {
      return this.testDelegate.set(account, record);
    }
    const client = await this.readyClient();
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
    if (this.testDelegate) {
      return this.testDelegate.delete(account);
    }
    const client = await this.readyClient();
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
    if (this.testDelegate) {
      return this.testDelegate.list();
    }
    const client = await this.readyClient();
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
    if (this.testDelegate) {
      return this.testDelegate.bulkSet(records);
    }
    const client = await this.readyClient();
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
 * metadata operations always have a backend to talk to, and child processes
 * lazily open their own CES session through it.
 */
export const cesRecordBackend = new CesRpcRecordBackend();
