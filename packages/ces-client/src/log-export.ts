/**
 * IPC client for the CES log export.
 *
 * The IPC-only replacement for `http-log-export` — same result shape
 * (`{ ok, data }` tar.gz bytes), different transport. Log collection is a
 * rare diagnostic operation, so this opens a one-shot connection per export
 * (connect, handshake, `export_logs`, close) instead of holding a session.
 */

import { createConnection } from "node:net";
import { existsSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

import { CesRpcMethod } from "@mycadet/service-contracts/credential-rpc";

import { createCesRpcClient } from "./rpc-client.js";
import { getCesSocketPath } from "./socket-path.js";

// ---------------------------------------------------------------------------
// Types (shared with the HTTP client's shapes)
// ---------------------------------------------------------------------------

/** Options for a log export request. */
export interface CesLogExportOptions {
  /** Start of the date range (epoch milliseconds). */
  startTime?: number;
  /** End of the date range (epoch milliseconds). */
  endTime?: number;
  /** Request timeout in milliseconds. Default: 120 000. */
  timeoutMs?: number;
}

/** Successful log export result. */
export interface CesLogExportSuccess {
  ok: true;
  /** Raw tar.gz archive bytes. */
  data: ArrayBuffer;
}

/** Failed log export result. */
export interface CesLogExportFailure {
  ok: false;
  /** Human-readable error message. */
  error: string;
}

export type CesLogExportResult = CesLogExportSuccess | CesLogExportFailure;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 120_000;

const SOCKET_CONNECT_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * Fetch a tar.gz archive of CES logs over the shared Unix socket. The
 * archive bytes are returned for the consumer to stage/extract as needed.
 */
export async function exportCesLogs(
  options?: CesLogExportOptions,
): Promise<CesLogExportResult> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const socketPath = getCesSocketPath();

  if (!socketPath.startsWith("\\\\.\\pipe\\") && !existsSync(socketPath)) {
    return { ok: false, error: `CES socket not found at ${socketPath}` };
  }

  let rpc: ReturnType<typeof createCesRpcClient> | undefined;
  try {
    const transport = await connectSocket(socketPath, timeoutMs);
    rpc = createCesRpcClient(transport, {
      handshakeTimeoutMs: SOCKET_CONNECT_TIMEOUT_MS,
      requestTimeoutMs: timeoutMs,
    });

    const { accepted, reason } = await rpc.handshake();
    if (!accepted) {
      return { ok: false, error: `CES handshake rejected: ${reason}` };
    }

    const result = await rpc.call(CesRpcMethod.ExportLogs, {
      ...(options?.startTime !== undefined
        ? { startTime: options.startTime }
        : {}),
      ...(options?.endTime !== undefined ? { endTime: options.endTime } : {}),
    });

    const archive = Buffer.from(result.archiveBase64, "base64");
    const bytes = new ArrayBuffer(archive.byteLength);
    new Uint8Array(bytes).set(archive);
    return { ok: true, data: bytes };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    rpc?.close();
  }
}

// ---------------------------------------------------------------------------
// One-shot socket transport
// ---------------------------------------------------------------------------

interface SocketTransport {
  write(line: string): void;
  onMessage(handler: (message: string) => void): void;
  isAlive(): boolean;
  close(): void;
}

function connectSocket(
  socketPath: string,
  timeoutMs: number,
): Promise<SocketTransport> {
  return new Promise<SocketTransport>((resolve, reject) => {
    const socket = createConnection({ path: socketPath });
    const messageHandlers: Array<(message: string) => void> = [];
    let buffer = "";
    let closed = false;
    const decoder = new StringDecoder("utf8");

    const timer = setTimeout(
      () => {
        socket.destroy();
        reject(
          new Error(
            `Connection to CES socket at ${socketPath} timed out after ${SOCKET_CONNECT_TIMEOUT_MS}ms`,
          ),
        );
      },
      Math.min(SOCKET_CONNECT_TIMEOUT_MS, timeoutMs),
    );

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
      if (timer.hasRef?.()) {
        clearTimeout(timer);
        socket.destroy();
        reject(err);
      }
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
