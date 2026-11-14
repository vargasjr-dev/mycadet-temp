/**
 * CES socket path resolution — shared by every process that dials or binds
 * the CES Unix socket (credential-executor, assistant, gateway, CLI).
 *
 * `ces.sock` lives in its own IPC directory, a sibling of the CES data dir
 * (never inside it — the data dir is CES-private, the socket is the shared
 * rendezvous). Containers default to `/run/ces-ipc`, matching the
 * assistant and gateway IPC layout (`/run/assistant-ipc`, `/run/gateway-ipc`);
 * bare-metal runs set `CES_SOCKET_DIR` to a per-instance directory.
 */

import { resolveIpcEndpoint } from "@mycadet/ipc-server-utils";

/** Default directory for the CES Unix socket (containerized mode). */
export const CES_SOCKET_DIR_DEFAULT = "/run/ces-ipc";

/**
 * The directory holding `ces.sock`: `CES_SOCKET_DIR` when set, otherwise
 * `/run/ces-ipc`.
 */
export function getCesSocketDir(): string {
  return process.env["CES_SOCKET_DIR"]?.trim() || CES_SOCKET_DIR_DEFAULT;
}

/**
 * The path to the CES Unix socket used in every environment.
 *
 * Local siblings and managed sidecars share this resolver. The assistant and
 * gateway dial the same path CES binds. Resolved through `resolveIpcEndpoint`
 * so macOS AF_UNIX limits and Windows named pipes stay consistent.
 */
export function getCesSocketPath(): string {
  return resolveIpcEndpoint("ces", { workspaceDir: getCesSocketDir() }).path;
}
