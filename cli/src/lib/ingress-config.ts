import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  INGRESS_ASSISTANT_ID_KEY,
  INGRESS_LAST_TUNNEL_KEY,
  INGRESS_PAIRING_TUNNEL_KEY,
  type TunnelProviderName,
  type TunnelRecord,
} from "@mycadet/service-contracts/ingress";

import {
  lookupAssistantByIdentifier,
  readEdgeShellSelection,
  saveAssistantEntry,
  saveEdgeShellSelection,
  type AssistantEntry,
} from "./assistant-config.js";
import { getStateDir } from "./environments/paths.js";
import { getCurrentEnvironment } from "./environments/resolve.js";

/**
 * Shared workspace-config helpers for tunnel providers and the nginx ingress
 * proxy. Each provider fronts the local edge and records the resulting public
 * URL under `ingress.publicBaseUrl` so webhook integrations can reach the
 * assistant. The workspace config is the gateway-facing contract; when an
 * `assistantId` is supplied, the URL is also mirrored onto the lockfile entry
 * (`ingressUrl`) — the CLI-owned contract that CLI features (e.g. remote-web
 * pairing defaults) read, per the no-`.cadet/`-reads boundary in cli/AGENTS.md.
 */

function parsePortFromUrl(url: unknown): number | undefined {
  if (typeof url !== "string" || !url.trim()) return undefined;
  try {
    const port = Number(new URL(url).port);
    return Number.isInteger(port) && port > 0 && port <= 65535
      ? port
      : undefined;
  } catch {
    return undefined;
  }
}

/** Container topologies whose gateway runs on this machine without host `resources`. */
export function isLocalContainerEntry(entry: AssistantEntry): boolean {
  return entry.cloud === "docker" || entry.cloud === "apple-container";
}

/**
 * Derive the gateway port from an entry's recorded URLs, preferring the
 * loopback `localUrl` over `runtimeUrl`. Undefined when neither carries an
 * explicit port (e.g. a cloud-hosted https runtime URL).
 */
export function parseGatewayPortFromEntryUrls(
  entry: AssistantEntry | undefined,
): number | undefined {
  return (
    parsePortFromUrl(entry?.localUrl) ?? parsePortFromUrl(entry?.runtimeUrl)
  );
}

/**
 * Default workspace dir: `$CADET_WORKSPACE_DIR` or the XDG data root's
 * workspace (`$XDG_DATA_HOME/cadet[-<env>]/workspace`).
 */
export function getDefaultWorkspaceDir(): string {
  return (
    process.env.CADET_WORKSPACE_DIR?.trim() ||
    join(getStateDir(getCurrentEnvironment()), "workspace")
  );
}

/** Which client bundle the nginx edge serves as the outer shell. */
export type ShellMode = "web" | "app";

export const DEFAULT_SHELL_MODE: ShellMode = "web";

/**
 * Read the persisted shell mode from the CLI lockfile. The nginx edge is a
 * CLI-managed server — the lockfile's `app` record — not a per-cadet
 * setting, so its shell lives beside that record there rather than in any
 * one cadet's workspace config. Unset records read as the default so the
 * edge's behavior never depends on config files that predate the setting;
 * an unrecognized value fails loudly rather than silently serving a shell
 * the user did not ask for.
 */
export function readShellMode(): ShellMode {
  const raw = readEdgeShellSelection();
  if (raw === undefined) return DEFAULT_SHELL_MODE;
  if (raw === "web" || raw === "app") return raw;
  throw new Error(
    `The nginx edge shell mode must be "web" or "app" (got ${JSON.stringify(raw)}). ` +
      "Fix it in the CLI lockfile or run `cadet tunnel --shell <web|app>`.",
  );
}

/** Persist the shell mode to the CLI lockfile beside the nginx edge record. */
export function saveShellMode(mode: ShellMode): void {
  saveEdgeShellSelection(mode);
}

function getConfigPath(workspaceDir: string): string {
  return join(workspaceDir, "config.json");
}

/** Read the workspace `config.json`, or an empty object when it is absent. */
export function loadRawConfig(workspaceDir: string): Record<string, unknown> {
  const configPath = getConfigPath(workspaceDir);
  if (!existsSync(configPath)) return {};
  return JSON.parse(readFileSync(configPath, "utf-8")) as Record<
    string,
    unknown
  >;
}

/** Write the workspace `config.json`, creating parent directories as needed. */
export function saveRawConfig(
  workspaceDir: string,
  config: Record<string, unknown>,
): void {
  const configPath = getConfigPath(workspaceDir);
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
}

/** The ingress URL mirrored onto the lockfile entry, or null when it has none. */
export function readLockfileIngressUrl(assistantId: string): string | null {
  const result = lookupAssistantByIdentifier(assistantId);
  return result.status === "found" ? (result.entry.ingressUrl ?? null) : null;
}

/**
 * Mirror the ingress URL onto the lockfile entry; null removes it. Exported on
 * its own for tunnels that publish an address to pair against while leaving the
 * workspace `ingress` record (the webhook callback base) alone.
 */
export function stampLockfileIngressUrl(
  assistantId: string,
  publicUrl: string | null,
): void {
  const result = lookupAssistantByIdentifier(assistantId);
  if (result.status !== "found") {
    return;
  }
  const entry = result.entry;
  if (publicUrl) {
    entry.ingressUrl = publicUrl;
  } else {
    delete entry.ingressUrl;
  }
  saveAssistantEntry(entry);
}

/**
 * Persist a public ingress URL to the workspace config and enable ingress.
 * `provider`/`assistantId` also land under `ingress.lastTunnel` and
 * `ingress.assistantId`: workspace-only records the daemon reads to report
 * tunnel health, deliberately not mirrored onto the lockfile.
 */
export function saveIngressUrl(
  workspaceDir: string,
  publicUrl: string,
  assistantId?: string,
  provider?: TunnelProviderName,
): void {
  const config = loadRawConfig(workspaceDir);
  const ingress = (config.ingress ?? {}) as Record<string, unknown>;
  ingress.publicBaseUrl = publicUrl;
  ingress.enabled = true;
  if (provider) {
    ingress[INGRESS_LAST_TUNNEL_KEY] = {
      provider,
      publicBaseUrl: publicUrl,
    } satisfies TunnelRecord;
  }
  // The daemon can't derive this: it uses 'self' internally.
  if (assistantId) {
    ingress[INGRESS_ASSISTANT_ID_KEY] = assistantId;
  }
  // This URL is the address to reach the assistant at, pairing included, so a
  // pairing-only record left by an earlier run no longer names one to prefer.
  delete ingress[INGRESS_PAIRING_TUNNEL_KEY];
  config.ingress = ingress;
  saveRawConfig(workspaceDir, config);
  if (assistantId) {
    stampLockfileIngressUrl(assistantId, publicUrl);
  }
}

/**
 * Persist the tunnel devices pair against under `ingress.pairingTunnel`, plus
 * the assistant it fronts; null drops the record.
 *
 * A tunnel that cannot carry webhook callbacks leaves `ingress.publicBaseUrl`
 * alone, so the lockfile mirror alone would leave it invisible to the daemon,
 * which reads only the workspace config. `ingress.assistantId` rides along
 * because the daemon's probe needs it to tell this assistant's edge from
 * someone else's, and it names the same assistant either record fronts.
 */
export function savePairingTunnel(
  workspaceDir: string,
  record: TunnelRecord | null,
  assistantId?: string,
): void {
  const config = loadRawConfig(workspaceDir);
  const ingress = (config.ingress ?? {}) as Record<string, unknown>;
  if (record) {
    ingress[INGRESS_PAIRING_TUNNEL_KEY] = record;
    if (assistantId) {
      ingress[INGRESS_ASSISTANT_ID_KEY] = assistantId;
    }
  } else {
    delete ingress[INGRESS_PAIRING_TUNNEL_KEY];
  }
  config.ingress = ingress;
  saveRawConfig(workspaceDir, config);
}

/** Clear the ingress public base URL from the workspace config. */
export function clearIngressUrl(
  workspaceDir: string,
  assistantId?: string,
): void {
  const config = loadRawConfig(workspaceDir);
  const ingress = (config.ingress ?? {}) as Record<string, unknown>;
  // `lastTunnel`/`assistantId` survive teardown on purpose: readers name the
  // tunnel to restart once it is gone.
  delete ingress.publicBaseUrl;
  config.ingress = ingress;
  saveRawConfig(workspaceDir, config);
  if (assistantId) {
    stampLockfileIngressUrl(assistantId, null);
  }
}
