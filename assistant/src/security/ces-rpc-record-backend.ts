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

class CesRpcRecordBackend {
  /**
   * The live IPC session, opened by this backend's first record operation.
   * The session owns its transport and reconnection: after a CES restart the
   * same reference becomes ready again, so this backend never re-opens,
   * swaps, or even waits on clients — it opens once and every operation
   * either talks to that session or throws.
   */
  private client: CesSessionClient | undefined;

  /** Memoized open (single-flight across concurrent first operations). */
  private clientPromise: Promise<CesClient> | undefined;

  /** Sync snapshot of the live client; `undefined` until connected. */
  getClient(): CesClient | undefined {
    return this.client?.isReady() ? this.client : undefined;
  }

  /**
   * Resolve the client, opening our own CES IPC connection on first use.
   * Throws {@link CesUnavailableError} when CES is unreachable — callers
   * surface that rather than degrading, so a lost write is never mistaken
   * for a successful one.
   */
  async ensureClient(): Promise<CesClient> {
    this.clientPromise ??= createCesClient()
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
        // A failed open is not sticky: the next operation opens fresh.
        this.clientPromise = undefined;
        throw err;
      });
    return this.clientPromise;
  }

  /** Close the backend's connection (one-shot CLI processes call this on exit). */
  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.clientPromise = undefined;
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
