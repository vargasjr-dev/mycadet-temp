/**
 * In-process CES RPC test double served over a REAL unix socket.
 *
 * The production record backend discovers `ces.sock` under
 * `CES_SOCKET_DIR` and speaks the newline-delimited JSON RPC
 * protocol (`@mycadet/service-contracts` transport contract). This helper
 * binds that socket and answers handshake + record/credential requests from
 * an in-memory store — the real client, transport and discovery run
 * unmocked.
 *
 * Two ways to use it:
 * - `startTestCesRecordServer()` — self-contained: mints its own temp socket
 *   dir and patches `process.env.CES_SOCKET_DIR` so in-process callers dial
 *   the fake. Install BEFORE the first backend operation.
 * - `startTestCesRecordServer({ socketDir })` — for tests that spawn a CHILD
 *   process (gateway, assistant) which must be given the socket dir in its
 *   env up front: bind a dir the caller chose and never touch `process.env`.
 *   Pass a dir that does not exist yet to simulate "CES will appear later".
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveIpcEndpoint } from "@mycadet/ipc-server-utils";
import { CES_PROTOCOL_VERSION } from "@mycadet/service-contracts";
import type { CredentialRecord } from "@mycadet/service-contracts/credential-rpc";
import { CesRpcMethod } from "@mycadet/service-contracts/credential-rpc";

export interface TestCesRecordServer {
  /** Secret-value store backing get/set/delete/list_credential. */
  secrets: Map<string, string>;
  /** Record store backing the *_credential_record methods. */
  records: Map<string, CredentialRecord>;
  /** Every RPC request that reached the server, in order. */
  calls: Array<{ method: CesRpcMethod; request: unknown }>;
  /** Make every set/bulk-set RPC fail. */
  failSet: boolean;
  /** Make every list RPC throw (a transport-level outage). */
  failList: boolean;
  /** Whether the socket is currently listening. */
  listening: boolean;
  /** Drop every open connection (a CES bounce). */
  dropConnections: () => void;
  /** Stop listening and remove the temp socket dir (CES unreachable). */
  stop: () => Promise<void>;
  /** Listen again on a fresh socket dir (CES came back). */
  start: () => void;
}

export function startTestCesRecordServer(options?: {
  socketDir?: string;
}): TestCesRecordServer {
  const secrets = new Map<string, string>();
  const records = new Map<string, CredentialRecord>();
  const calls: Array<{ method: CesRpcMethod; request: unknown }> = [];
  const state = { failSet: false, failList: false };
  const ownsEnv = options?.socketDir === undefined;

  const sockets = new Set<Socket>();
  let server: Server | undefined;
  let socketDir: string | undefined;

  const listen = (): void => {
    if (server) {
      return;
    }
    socketDir =
      options?.socketDir ?? mkdtempSync(join(tmpdir(), "test-ces-socket-"));
    if (ownsEnv) {
      process.env.CES_SOCKET_DIR = socketDir;
    }
    mkdirSync(socketDir, { recursive: true });
    const socketPath = resolveIpcEndpoint("ces", {
      workspaceDir: socketDir,
    }).path;
    server = createServer((socket) => wire(socket));
    server.listen(socketPath);
  };

  const handleRpc = (
    id: string,
    method: CesRpcMethod,
    request: unknown,
  ): unknown => {
    calls.push({ method, request });
    const req = request as {
      account?: string;
      value?: string;
      record?: CredentialRecord;
      records?: Array<{ account: string; record: CredentialRecord }>;
      credentials?: Array<{ account: string; value: string }>;
    };
    switch (method) {
      case CesRpcMethod.GetCredential: {
        const value =
          req.account !== undefined ? secrets.get(req.account) : undefined;
        return value !== undefined ? { found: true, value } : { found: false };
      }
      case CesRpcMethod.SetCredential: {
        if (state.failSet || req.account === undefined) {
          return { ok: false };
        }
        secrets.set(req.account, req.value ?? "");
        return { ok: true };
      }
      case CesRpcMethod.DeleteCredential: {
        if (req.account === undefined || !secrets.has(req.account)) {
          return { result: "not-found" };
        }
        secrets.delete(req.account);
        return { result: "deleted" };
      }
      case CesRpcMethod.ListCredentials: {
        if (state.failList) {
          throw new Error("credential list transport failed");
        }
        return { accounts: [...secrets.keys()] };
      }
      case CesRpcMethod.GetCredentialRecord: {
        const record =
          req.account !== undefined ? records.get(req.account) : undefined;
        return record ? { found: true, record } : { found: false };
      }
      case CesRpcMethod.SetCredentialRecord: {
        if (state.failSet || !req.account || !req.record) {
          return { ok: false };
        }
        records.set(req.account, req.record);
        return { ok: true };
      }
      case CesRpcMethod.DeleteCredentialRecord: {
        if (!req.account || !records.has(req.account)) {
          return { result: "not-found" };
        }
        records.delete(req.account);
        return { result: "deleted" };
      }
      case CesRpcMethod.ListCredentialRecords: {
        if (state.failList) {
          throw new Error("record list transport failed");
        }
        return {
          records: [...records.entries()].map(([account, record]) => ({
            account,
            record,
          })),
        };
      }
      case CesRpcMethod.BulkSetCredentialRecords: {
        const results = (req.records ?? []).map((entry) => {
          if (state.failSet) {
            return { account: entry.account, ok: false };
          }
          records.set(entry.account, entry.record);
          return { account: entry.account, ok: true };
        });
        return { results };
      }
      default:
        return {};
    }
  };

  const wire = (socket: Socket): void => {
    sockets.add(socket);
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (!line) {
          continue;
        }
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (message.type === "handshake_request") {
          socket.write(
            `${JSON.stringify({
              type: "handshake_ack",
              protocolVersion: CES_PROTOCOL_VERSION,
              sessionId: message.sessionId,
              accepted: message.protocolVersion === CES_PROTOCOL_VERSION,
            })}\n`,
          );
          continue;
        }
        if (message.type === "rpc" && message.kind === "request") {
          let payload: unknown;
          try {
            payload = handleRpc(
              String(message.id),
              message.method as CesRpcMethod,
              message.payload,
            );
          } catch {
            socket.write(
              `${JSON.stringify({
                kind: "response",
                id: message.id,
                error: {
                  code: "CES_INTERNAL",
                  message: "test server failure",
                },
              })}\n`,
            );
            continue;
          }
          socket.write(
            `${JSON.stringify({ kind: "response", id: message.id, payload })}\n`,
          );
        }
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  };

  listen();

  return {
    secrets,
    records,
    calls,
    get failSet() {
      return state.failSet;
    },
    set failSet(v: boolean) {
      state.failSet = v;
    },
    get failList() {
      return state.failList;
    },
    set failList(v: boolean) {
      state.failList = v;
    },
    get listening() {
      return !!server;
    },
    dropConnections: () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      sockets.clear();
    },
    stop: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      sockets.clear();
      await new Promise<void>((resolve) => {
        if (!server) {
          resolve();
          return;
        }
        server.close(() => resolve());
      });
      server = undefined;
      if (socketDir && ownsEnv) {
        rmSync(socketDir, { recursive: true, force: true });
      }
      if (ownsEnv) {
        // While stopped, discovery must NOT fall through to a live machine
        // socket — point it at an empty dir.
        const emptyDir = mkdtempSync(join(tmpdir(), "test-ces-empty-"));
        process.env.CES_SOCKET_DIR = emptyDir;
        socketDir = emptyDir;
      } else {
        socketDir = undefined;
      }
    },
    start: listen,
  };
}
