/**
 * IPC client for CES credential CRUD over the shared Unix socket.
 *
 * The IPC-only replacement for `http-credentials` — same surface, different
 * transport. Every CES caller (assistant, gateway, CLI) dials the socket CES
 * binds; there are no HTTP routes to authenticate against and no
 * CES_SERVICE_TOKEN to manage.
 *
 * The connection is opened lazily on first use, handshakes once, and is
 * reused across calls; a dead transport re-opens on the next operation after
 * a short cooldown so a down CES costs one discovery attempt per window
 * instead of one per call.
 */

import { createConnection, type Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";

import { existsSync } from "node:fs";

import type { CesRpcContract } from "@mycadet/service-contracts/credential-rpc";
import { CesRpcMethod } from "@mycadet/service-contracts/credential-rpc";
import type { CredentialRecord } from "@mycadet/service-contracts/credential-rpc";

import { getBootstrapSocketPath } from "./socket-path.js";
import {
  createCesRpcClient,
  type CesRpcClient,
} from "./rpc-client.js";

export type { CredentialRecord };

// ---------------------------------------------------------------------------
// Result types (shared with the HTTP client's shapes)
// ---------------------------------------------------------------------------

export interface CesCredentialGetResult {
  value: string | undefined;
  unreachable: boolean;
}

export interface CesCredentialListResult {
  accounts: string[];
  unreachable: boolean;
}

export type CesDeleteResult = "deleted" | "not-found" | "error";

/** Minimal logger interface — callers can supply pino, console, etc. */
export interface CesIpcLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
  warn(msg: string): void;
}

// ---------------------------------------------------------------------------
// Client interface — method-compatible with the HTTP credential client
// ---------------------------------------------------------------------------

export interface CesIpcCredentialClient {
  /** Whether the CES socket is present and dialable. */
  isAvailable(): boolean;

  /** Retrieve a credential by account name. */
  get(account: string): Promise<CesCredentialGetResult>;

  /** Store or update a credential. */
  set(account: string, value: string): Promise<boolean>;

  /** Delete a credential by account name. */
  delete(account: string): Promise<CesDeleteResult>;

  /** Bulk-set multiple credentials. */
  bulkSet(
    credentials: Array<{ account: string; value: string }>,
  ): Promise<Array<{ account: string; ok: boolean }>>;

  /** List all credential account names. */
  list(): Promise<CesCredentialListResult>;

  /** Retrieve a credential record (identity + policy) by account name. */
  getRecord(
    account: string,
  ): Promise<{ record: CredentialRecord | undefined; unreachable: boolean }>;

  /** Store or update a credential record. */
  setRecord(account: string, record: CredentialRecord): Promise<boolean>;

  /** Delete a credential record by account name. */
  deleteRecord(account: string): Promise<CesDeleteResult>;

  /** List all credential records. */
  listRecords(): Promise<{
    records: Array<{ account: string; record: CredentialRecord }>;
    unreachable: boolean;
  }>;

  /** Bulk-set credential records. */
  bulkSetRecords(
    records: Array<{ account: string; record: CredentialRecord }>,
  ): Promise<Array<{ account: string; ok: boolean }>>;
}

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Minimum interval between connection attempts after a failure. */
const CONNECT_COOLDOWN_MS = 3_000;

const SOCKET_CONNECT_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Socket transport
// ---------------------------------------------------------------------------

interface SocketTransport {
  write(line: string): void;
  onMessage(handler: (message: string) => void): void;
  isAlive(): boolean;
  close(): void;
}

function connectSocket(
  socketPath: string,
  logger: CesIpcLogger,
): Promise<SocketTransport> {
  return new Promise<SocketTransport>((resolve, reject) => {
    const socket = createConnection({ path: socketPath });
    const messageHandlers: Array<(message: string) => void> = [];
    let buffer = "";
    let closed = false;
    const decoder = new StringDecoder("utf8");

    const timer = setTimeout(() => {
      socket.destroy();
      reject(
        new Error(
          `Connection to CES socket at ${socketPath} timed out after ${SOCKET_CONNECT_TIMEOUT_MS}ms`,
        ),
      );
    }, SOCKET_CONNECT_TIMEOUT_MS);

    socket.on("connect", () => {
      clearTimeout(timer);
      resolve({
        write(line: string): void {
          if (closed || socket.destroyed) {
            throw new Error("CES socket transport is not alive");
          }
          socket.write(line + "\n");
        },
        onMessage(handler: (message: string) => void): void {
          messageHandlers.push(handler);
        },
        isAlive(): boolean {
          return !closed && !socket.destroyed;
        },
        close(): void {
          closed = true;
          socket.destroy();
        },
      });
    });

    socket.on("error", (err) => {
      // Reject first-connect failures fast (refused, ENOENT on a stale
      // socket file); post-connect errors are transport deaths, logged and
      // surfaced through the next call's unreachable mapping.
      if (timer.hasRef?.()) {
        clearTimeout(timer);
        socket.destroy();
        reject(err);
        return;
      }
      logger.warn({ err }, "CES socket transport error");
    });

    socket.on("data", (chunk: Buffer | string) => {
      buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (line) {
          for (const handler of messageHandlers) {
            handler(line);
          }
        }
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCesIpcCredentialClient(
  logger: CesIpcLogger,
): CesIpcCredentialClient {
  let client: CesRpcClient | undefined;
  let clientAttempt: Promise<CesRpcClient> | undefined;
  let lastFailedAttemptAt = 0;

  function isAvailable(): boolean {
    const socketPath = getBootstrapSocketPath();
    return socketPath.startsWith("\\\\.\\pipe\\") || existsSync(socketPath);
  }

  /**
   * Resolve the connected+handshaked RPC client, opening the socket session
   * on first use and after any transport death. Throws when CES is
   * unreachable; callers map that to their own failure semantics.
   */
  async function ensureClient(): Promise<CesRpcClient> {
    if (client?.isReady()) {
      return client;
    }
    client = undefined;
    if (Date.now() - lastFailedAttemptAt < CONNECT_COOLDOWN_MS) {
      throw new Error("CES is unreachable (recent connection attempt failed)");
    }
    if (!clientAttempt) {
      clientAttempt = (async () => {
        const socketPath = getBootstrapSocketPath();
        const transport = await connectSocket(socketPath, logger);
        const rpc = createCesRpcClient(transport, {
          handshakeTimeoutMs: SOCKET_CONNECT_TIMEOUT_MS,
          logger: {
            info: (objOrMsg: Record<string, unknown> | string, msg?: string) =>
              typeof objOrMsg === "string"
                ? logger.warn(objOrMsg)
                : logger.warn(objOrMsg, msg ?? ""),
          },
        });
        const { accepted, reason } = await rpc.handshake();
        if (!accepted) {
          rpc.close();
          throw new Error(`CES handshake rejected: ${reason ?? "unknown"}`);
        }
        client = rpc;
        return rpc;
      })()
        .catch((err) => {
          lastFailedAttemptAt = Date.now();
          throw err;
        })
        .finally(() => {
          clientAttempt = undefined;
        });
    }
    return clientAttempt;
  }

  /** Run one RPC call, mapping transport failure to `unreachable`. */
  async function callOrUnreachable<M extends CesRpcMethod>(
    method: M,
    request: CesRpcContract[M]["request"],
  ): Promise<
    { ok: true; response: CesRpcContract[M]["response"] } | { ok: false }
  > {
    try {
      const rpc = await ensureClient();
      const response = await rpc.call(method, request);
      return { ok: true, response };
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), method },
        "CES IPC call failed",
      );
      client = undefined;
      return { ok: false };
    }
  }

  return {
    isAvailable,

    async get(account) {
      const result = await callOrUnreachable(CesRpcMethod.GetCredential, {
        account,
      });
      if (!result.ok) return { value: undefined, unreachable: true };
      return {
        value: result.response.found ? result.response.value : undefined,
        unreachable: false,
      };
    },

    async set(account, value) {
      const result = await callOrUnreachable(CesRpcMethod.SetCredential, {
        account,
        value,
      });
      return result.ok && result.response.ok;
    },

    async delete(account) {
      const result = await callOrUnreachable(CesRpcMethod.DeleteCredential, {
        account,
      });
      if (!result.ok) return "error";
      return result.response.result;
    },

    async bulkSet(credentials) {
      const result = await callOrUnreachable(
        CesRpcMethod.BulkSetCredentials,
        { credentials },
      );
      if (!result.ok) {
        return credentials.map(({ account }) => ({ account, ok: false }));
      }
      return result.response.results;
    },

    async list() {
      const result = await callOrUnreachable(CesRpcMethod.ListCredentials, {});
      if (!result.ok) return { accounts: [], unreachable: true };
      return { accounts: result.response.accounts, unreachable: false };
    },

    async getRecord(account) {
      const result = await callOrUnreachable(
        CesRpcMethod.GetCredentialRecord,
        { account },
      );
      if (!result.ok) return { record: undefined, unreachable: true };
      return { record: result.response.record, unreachable: false };
    },

    async setRecord(account, record) {
      const result = await callOrUnreachable(
        CesRpcMethod.SetCredentialRecord,
        { account, record },
      );
      return result.ok && result.response.ok;
    },

    async deleteRecord(account) {
      const result = await callOrUnreachable(
        CesRpcMethod.DeleteCredentialRecord,
        { account },
      );
      if (!result.ok) return "error";
      return result.response.result;
    },

    async listRecords() {
      const result = await callOrUnreachable(
        CesRpcMethod.ListCredentialRecords,
        {},
      );
      if (!result.ok) return { records: [], unreachable: true };
      return { records: result.response.records, unreachable: false };
    },

    async bulkSetRecords(records) {
      const result = await callOrUnreachable(
        CesRpcMethod.BulkSetCredentialRecords,
        { records },
      );
      if (!result.ok) {
        return records.map(({ account }) => ({ account, ok: false }));
      }
      return result.response.results;
    },
  };
}
