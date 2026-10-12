import { resolveIpcEndpoint } from "@mycadet/ipc-server-utils";

import { getWorkspaceDir } from "../util/layout.js";

export function resolveIpcSocketPath(socketName: string): {
  path: string;
  source: string;
} {
  return resolveIpcEndpoint(socketName, { workspaceDir: getWorkspaceDir() });
}

export function getAssistantSocketPath(): string {
  return resolveIpcSocketPath("assistant").path;
}
