import { randomBytes } from "crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";

import { SEEDS, type EnvironmentDefinition } from "@mycadet/environments";
import { withLockfileLock } from "@mycadet/local-mode";
import {
  LockfileSchema,
  type LocalAssistantResources,
  type Lockfile,
  type LockfileAssistant,
} from "@mycadet/local-mode/contract";

import { crossEnvironmentAssistantHint } from "./environments/detect.js";
import {
  getDefaultPorts,
  getLockfilePath,
  getLockfilePaths,
  getMultiInstanceDir,
  getStateDir,
} from "./environments/paths.js";
import { getCurrentEnvironment } from "./environments/resolve.js";
import { probePort } from "./port-probe.js";

/**
 * Per-instance resource paths and ports. Each local assistant instance gets its
 * own directory tree, ports, and socket so multiple instances can run
 * side-by-side without conflicts. Extends the renderer-safe resources contract
 * (`instanceDir`, `gatewayPort`, `daemonPort`) with the host-only ports and the
 * signing key. Host-only and same-process, so it is a plain type — the
 * renderer-facing shape is the one with a Zod contract.
 */
export type LocalInstanceResources = LocalAssistantResources & {
  /**
   * Instance-specific data root. New local assistants are placed under
   * `$XDG_DATA_HOME/cadet{-env}/assistants/<name>/` with state flattened
   * directly into it. Legacy entries (pre env-data-layout) may still point
   * at `~` — the read path honors whatever `instanceDir` is stored, with
   * state in `~/.cadet` for those.
   */
  instanceDir: string;
  /** HTTP port for the Qdrant vector store */
  qdrantPort: number;
  /** HTTP port for the CES (Claude Extension Server) */
  cesPort: number;
  /** Persisted HMAC signing key (hex). Survives daemon/gateway restarts so
   *  client actor tokens remain valid across `wake` cycles. */
  signingKey?: string;
  /** Version of the npm-backed local runtime this assistant should run. */
  runtimeVersion?: string;
  /** Install directory containing the npm-backed local runtime packages. */
  runtimeInstallDir?: string;
  [key: string]: unknown;
};

/** Docker image metadata for the service group. Enables rollback to known-good refs. */
export interface ContainerInfo {
  assistantImage: string;
  gatewayImage: string;
  cesImage: string;
  /**
   * Host-side port the assistant HTTP API is published on. Dynamically
   * allocated at hatch time so concurrent instances don't collide on the
   * default (7821). Stored so rollback/upgrade can rebind the same port
   * instead of re-allocating (which could grab a different port if another
   * process took it in the interim).
   */
  assistantPort?: number;
}

/**
 * The CLI's full view of an assistant entry: the renderer-safe base
 * (`LockfileAssistant`, the one canonical Zod contract) plus the host-only and
 * sensitive fields the CLI reads and writes. Those extra fields never cross a
 * validation boundary — the same toolchain writes and reads them — so they are
 * modeled as plain types here rather than re-validated.
 *
 * `runtimeUrl` is required (`loadAllAssistants` only returns entries that have one)
 * and `resources` is the richer host shape. `cloud` is inherited from
 * `LockfileAssistant` (always present; normalized at the read seam — see
 * `loadAllAssistants`). The index signature preserves unknown on-disk fields so a
 * read→write round-trip never drops a newer writer's data.
 */
export type AssistantEntry = LockfileAssistant & {
  runtimeUrl: string;
  /** Per-instance resource config. Present for local entries in multi-instance setups. */
  resources?: LocalInstanceResources;
  /** Older lockfile key for the display name, if present. */
  assistantName?: string;
  /** Loopback URL for same-machine health checks (e.g. `http://127.0.0.1:7831`).
   *  Avoids mDNS resolution issues when the machine checks its own gateway. */
  localUrl?: string;
  bearerToken?: string;
  project?: string;
  region?: string;
  sshUser?: string;
  zone?: string;
  /** PID of the file watcher process for docker instances hatched with --watch. */
  watcherPid?: number;
  /** Local bootstrap secret used to lease guardian tokens for Docker assistants after detached hatch. */
  guardianBootstrapSecret?: string;
  /** Docker image metadata for rollback. Only present for docker topology entries. */
  containerInfo?: ContainerInfo;
  /** Client-minted uuid (web's temp-client-id pattern) the CLI addresses this
   *  assistant's chat conversation by. Minted once on first `cadet client`
   *  launch and persisted here so every session shares one conversation. */
  conversationKey?: string;
  [key: string]: unknown;
};

export type AssistantLookupResult =
  | { status: "found"; entry: AssistantEntry }
  | { status: "not_found" }
  | { status: "ambiguous"; matches: AssistantEntry[] };

/**
 * A CLI-managed OS process recorded at the lockfile root under `tunnel`:
 * the auto-tunnel agent fronting the edge. `cadet ps` renders it alongside
 * the per-assistant process trees, and the stop paths verify the pid before
 * signaling it.
 */
export interface TunnelProcessRecord {
  pid: number;
  /** Which tunnel provider owns the process. */
  provider: string;
  /** The assistant the process fronts, so `cadet ps` can nest the row. */
  assistantId?: string;
  startedAt: string;
  /** The public URL the tunnel agent serves. */
  publicUrl?: string;
  /** Tunnel temporarily displaced by a pairing-only tunnel. */
  previous?: TunnelProcessRecord;
}

/**
 * A CLI-managed OS process recorded at the lockfile root under `app`: the
 * nginx ingress edge (web artifacts, `/v1` proxying, the outer shell).
 * Shares nothing with the tunnel record beyond the pid bookkeeping — a
 * tunnel serves a URL, the edge serves a port.
 */
export interface AppProcessRecord {
  /**
   * The edge process's bookkeeping, present while the edge runs. Absent on
   * a stamp-only entry: the built-sha stamp below survives the edge's own
   * stop, so between runs the `app` entry may carry only that.
   */
  pid?: number;
  /** The assistant the edge fronts, so `cadet ps` can nest the row. */
  assistantId?: string;
  startedAt?: string;
  /** Listening port for the nginx edge. */
  port?: number;
  /**
   * The commit the edge's source-built client bundles were last built from
   * — the auto-build staleness stamp. Lives on the edge's own record rather
   * than beside each dist so the CLI lockfile is the single home for edge
   * state, and survives the edge's own stop (a build-cache fact, not a
   * process fact) so restarting the edge never pays a needless rebuild.
   */
  builtSha?: string;
}

/** Either lockfile-root process record, keyed by `RootProcessKind`. */
export type RootProcessRecord = TunnelProcessRecord | AppProcessRecord;

/** The lockfile-root process entries keyed by their kind. */
export interface RootProcessRecords {
  tunnel?: TunnelProcessRecord;
  app?: AppProcessRecord;
}

export type RootProcessKind = keyof RootProcessRecords;

/**
 * Derive the daemon PID file path from a resources object. The PID file
 * lives inside the instance's workspace directory. When no resources are
 * available, falls back to the XDG data root's workspace
 * (`$XDG_DATA_HOME/cadet[-<env>]/workspace/cadet.pid`).
 */
export function getDaemonPidPath(resources?: LocalInstanceResources): string {
  const cadetDir = resources
    ? resources.instanceDir
    : getStateDir(getCurrentEnvironment());
  return join(cadetDir, "workspace", "cadet.pid");
}

function readLockfile(): Lockfile {
  for (const lockfilePath of getLockfilePaths(getCurrentEnvironment())) {
    if (!existsSync(lockfilePath)) continue;
    try {
      const parsed = LockfileSchema.safeParse(
        JSON.parse(readFileSync(lockfilePath, "utf-8")),
      );
      if (parsed.success) {
        return parsed.data;
      }
    } catch {
      // Malformed lockfile; try next
    }
  }
  return LockfileSchema.parse({});
}

function writeLockfileUnlocked(data: Lockfile): void {
  const lockfilePath = getLockfilePath(getCurrentEnvironment());
  mkdirSync(dirname(lockfilePath), { recursive: true });
  const tmpPath = `${lockfilePath}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n");
    renameSync(tmpPath, lockfilePath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {}
    throw err;
  }
}

/**
 * Run `fn` under the same cross-process advisory lock the local-mode hosts
 * use, keyed to this environment's write-path lockfile, so CLI writers and
 * package-side writers (Electron main, Vite plugin, `cadet client`) never
 * interleave read-modify-write cycles. Reentrant, so wrapped units may call
 * the locked write helpers. Throws on lock timeout, matching the fs-error
 * contract of the write path.
 */
function withCliLockfileLock<T>(fn: () => T): T {
  const locked = withLockfileLock(
    [getLockfilePath(getCurrentEnvironment())],
    fn,
  );
  if (!locked.ok) throw new Error(locked.error);
  return locked.value;
}

/** Record a CLI-managed root process (tunnel agent, app edge) by pid. */
export function stampRootProcess<K extends RootProcessKind>(
  kind: K,
  record: RootProcessRecords[K],
): void {
  withCliLockfileLock(() => {
    const data = readLockfile();
    (data as RootProcessRecords)[kind] = record;
    writeLockfileUnlocked(data);
  });
}

/** Release a recorded process, preserving a replacement or restoring a displaced record. */
export function clearRootProcess(
  kind: RootProcessKind,
  expectedPid?: number,
): void {
  withCliLockfileLock(() => {
    const data = readLockfile();
    const record = (data as RootProcessRecords)[kind];
    if (
      record === undefined ||
      (expectedPid !== undefined && record.pid !== expectedPid)
    )
      return;
    // Only a tunnel record carries a displaced predecessor to restore.
    const previous =
      kind === "tunnel" ? (record as TunnelProcessRecord).previous : undefined;
    if (previous) (data as RootProcessRecords).tunnel = previous;
    else delete data[kind];
    writeLockfileUnlocked(data);
  });
}

/**
 * Read the root-level process entries for `cadet ps`. Read-only: no lock, so
 * a concurrently-updating lockfile is fine — the pid is verified separately.
 */
export function readRootProcesses(): RootProcessRecords {
  const data = readLockfile();
  return { tunnel: data.tunnel, app: data.app };
}

/**
 * The edge's recorded built-sha stamp (the auto-build staleness marker the
 * resolver compares against the checkout's HEAD), or undefined when none is
 * recorded yet.
 */
export function readAppBuiltSha(): string | undefined {
  return readRootProcesses().app?.builtSha;
}

/**
 * Record the built-sha stamp on the `app` entry, creating a stamp-only entry
 * when the edge has not stamped its process yet (the stamp is written as
 * soon as a build lands, before the edge process exists).
 */
export function stampAppBuiltSha(builtSha: string): void {
  withCliLockfileLock(() => {
    const data = readLockfile();
    if (data.app) {
      data.app.builtSha = builtSha;
    } else {
      data.app = { builtSha };
    }
    writeLockfileUnlocked(data);
  });
}

/**
 * Release the edge's process entry. The built-sha stamp is a build-cache
 * fact rather than a process fact, so it is kept while the pid bookkeeping
 * goes — restarting the edge re-stamps the process fields without paying a
 * needless bundle rebuild.
 */
export function clearAppProcessRecord(expectedPid?: number): void {
  withCliLockfileLock(() => {
    const data = readLockfile();
    const record = data.app;
    if (
      record === undefined ||
      (expectedPid !== undefined && record.pid !== expectedPid)
    )
      return;
    if (record.builtSha !== undefined) {
      data.app = { builtSha: record.builtSha };
    } else {
      delete data.app;
    }
    writeLockfileUnlocked(data);
  });
}

/**
 * Try to extract a port number from a URL string (e.g. `http://localhost:7830`).
 * Returns undefined if the URL is malformed or has no explicit port.
 */

export function loadAllAssistants(): AssistantEntry[] {
  const data = readLockfile();
  return data.assistants.filter(isAssistantEntry);
}

/**
 * `assistantId` is the schema's job; `runtimeUrl` stays a plain read because
 * only entries that carry one are addressable.
 */
function isAssistantEntry(entry: LockfileAssistant): entry is AssistantEntry {
  return typeof entry.runtimeUrl === "string";
}

function writeAssistants(entries: AssistantEntry[]): void {
  withCliLockfileLock(() => {
    const data = readLockfile();
    data.assistants = entries;
    writeLockfileUnlocked(data);
  });
}

export function loadLatestAssistant(): AssistantEntry | null {
  const entries = loadAllAssistants();
  if (entries.length === 0) {
    return null;
  }
  const sorted = [...entries].sort((a, b) => {
    const ta = a.hatchedAt ? new Date(a.hatchedAt).getTime() : 0;
    const tb = b.hatchedAt ? new Date(b.hatchedAt).getTime() : 0;
    return tb - ta;
  });
  return sorted[0];
}

export function findAssistantByName(name: string): AssistantEntry | null {
  return (
    loadAllAssistants().find((entry) => entry.assistantId === name) ?? null
  );
}

export function getAssistantDisplayName(entry: AssistantEntry): string {
  const primary = entry.name?.trim();
  if (primary) return primary;

  const legacy = entry.assistantName?.trim();
  if (legacy) return legacy;

  return entry.assistantId;
}

export function formatAssistantReference(entry: AssistantEntry): string {
  const displayName = getAssistantDisplayName(entry);
  return displayName === entry.assistantId
    ? entry.assistantId
    : `${displayName} (${entry.assistantId})`;
}

function getAssistantDisplayNameCandidates(entry: AssistantEntry): string[] {
  return Array.from(
    new Set(
      [entry.name?.trim(), entry.assistantName?.trim()].filter(
        (value): value is string => typeof value === "string" && value !== "",
      ),
    ),
  );
}

export function lookupAssistantByIdentifier(
  identifier: string,
): AssistantLookupResult {
  const entries = loadAllAssistants();
  const exactId = entries.find((entry) => entry.assistantId === identifier);
  if (exactId) {
    return { status: "found", entry: exactId };
  }

  const displayMatches = entries.filter((entry) =>
    getAssistantDisplayNameCandidates(entry).includes(identifier),
  );
  if (displayMatches.length === 1) {
    return { status: "found", entry: displayMatches[0] };
  }
  if (displayMatches.length > 1) {
    return { status: "ambiguous", matches: displayMatches };
  }

  return { status: "not_found" };
}

export function formatAssistantLookupError(
  identifier: string,
  result: AssistantLookupResult = lookupAssistantByIdentifier(identifier),
): string {
  if (result.status === "ambiguous") {
    const matches = result.matches
      .map((entry) => formatAssistantReference(entry))
      .join(", ");
    return `Multiple assistants match '${identifier}': ${matches}. Use the assistant ID to disambiguate.`;
  }

  return `No assistant found with name or ID '${identifier}'.${crossEnvironmentAssistantHint() ?? ""}`;
}

export function removeAssistantEntry(assistantId: string): void {
  withCliLockfileLock(() => {
    const data = readLockfile();
    const entries = data.assistants.filter(
      (e) => e.assistantId !== assistantId,
    );
    data.assistants = entries;
    // Reassign active assistant if it matches the removed entry
    if (data.activeAssistant === assistantId) {
      const remaining = entries[0];
      if (remaining) {
        data.activeAssistant = String(remaining.assistantId);
      } else {
        data.activeAssistant = null;
      }
    }
    writeLockfileUnlocked(data);
  });
}

/**
 * Read the first existing lockfile for an explicitly-provided environment,
 * without applying legacy migrations. This is the cross-env read path used by
 * {@link loadAllAssistantsAcrossEnvs}: it deliberately bypasses
 * {@link readLockfile} (which always resolves the *current* env) so callers
 * can enumerate state from every env without flipping `process.env` or the
 * persisted default. Migrations are skipped because we never want to write
 * to another env's lockfile from the current env's process.
 */
function readLockfileForEnv(env: EnvironmentDefinition): Lockfile {
  for (const lockfilePath of getLockfilePaths(env)) {
    if (!existsSync(lockfilePath)) continue;
    try {
      const parsed = LockfileSchema.safeParse(
        JSON.parse(readFileSync(lockfilePath, "utf-8")),
      );
      if (parsed.success) {
        return parsed.data;
      }
    } catch {
      // Malformed; try next candidate
    }
  }
  return LockfileSchema.parse({});
}

/**
 * Load assistant entries from every known environment's lockfile.
 *
 * Each {@link SEEDS} entry has its own on-host data layout (config dir,
 * lockfile path, data dir). A running assistant from `dev` is invisible to
 * `loadAllAssistants()` when the current env is `local`, but its host
 * processes (daemon/gateway/qdrant) still show up in `ps ax`. The orphan
 * detector and `cadet clean` need the union of all envs' entries to avoid
 * misclassifying — or worse, killing — another env's running services.
 *
 * Optional `envs` override is provided for testability so call sites can
 * inject a curated env list with `lockfileDirOverride` set, without having
 * to manipulate the global SEEDS table or process.env.
 */
export function loadAllAssistantsAcrossEnvs(
  envs?: EnvironmentDefinition[],
): AssistantEntry[] {
  const envList = envs ?? Object.values(SEEDS).map((env) => ({ ...env }));
  const all: AssistantEntry[] = [];
  for (const env of envList) {
    all.push(...readLockfileForEnv(env).assistants.filter(isAssistantEntry));
  }
  return all;
}

export function getActiveAssistant(): string | null {
  const data = readLockfile();
  return data.activeAssistant ?? null;
}

export function setActiveAssistant(assistantId: string): void {
  withCliLockfileLock(() => {
    const data = readLockfile();
    data.activeAssistant = assistantId;
    writeLockfileUnlocked(data);
  });
}

/**
 * Best-effort resolution of the target assistant. Returns null when no
 * match is found — callers decide how to handle the absence.
 *
 * Priority:
 * 1. Explicit name argument
 * 2. Active assistant set via `cadet use`
 * 3. Sole lockfile entry (any cloud)
 */
export function resolveAssistant(nameArg?: string): AssistantEntry | null {
  if (nameArg) {
    return findAssistantByName(nameArg);
  }

  const active = getActiveAssistant();
  if (active) {
    const entry = findAssistantByName(active);
    if (entry) return entry;
    // Active assistant no longer exists in lockfile — fall through
  }

  const all = loadAllAssistants();
  if (all.length === 1) return all[0];

  return null;
}

/**
 * Resolve which assistant to target for a command, exiting the process
 * with a user-facing error when resolution fails.
 *
 * Priority:
 * 1. Explicit name argument
 * 2. Active assistant set via `cadet use`
 * 3. Sole lockfile entry (any cloud)
 */
export function resolveTargetAssistant(nameArg?: string): AssistantEntry {
  if (nameArg) {
    const result = lookupAssistantByIdentifier(nameArg);
    if (result.status === "found") return result.entry;
    console.error(formatAssistantLookupError(nameArg, result));
  } else {
    const active = getActiveAssistant();
    if (active) {
      const result = lookupAssistantByIdentifier(active);
      if (result.status === "found") return result.entry;
      if (result.status === "ambiguous") {
        console.error(formatAssistantLookupError(active, result));
        process.exit(1);
      }
      // Active assistant no longer exists in lockfile — fall through.
    }

    const all = loadAllAssistants();
    if (all.length === 1) return all[0];

    if (all.length === 0) {
      console.error(
        `No assistant found. Run 'cadet hatch' first.${crossEnvironmentAssistantHint() ?? ""}`,
      );
    } else {
      console.error(
        `Multiple assistants found. Set an active assistant with 'cadet use <name>'.`,
      );
    }
  }
  process.exit(1);
}

/**
 * Extract the hostname from a URL string. Falls back to stripping the scheme
 * and taking the hostname portion if URL parsing fails.
 */
export function extractHostFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname;
  } catch {
    return url.replace(/^https?:\/\//, "").split(":")[0];
  }
}

export function saveAssistantEntry(entry: AssistantEntry): void {
  withCliLockfileLock(() => {
    const entries = loadAllAssistants().filter(
      (e) => e.assistantId !== entry.assistantId,
    );
    entries.unshift(entry);
    writeAssistants(entries);
  });
}

/**
 * The client-minted uuid this CLI addresses the assistant's chat
 * conversation by (web's temp-client-id pattern: clients/web
 * document-conversation mints a uuid, persists it, and passes it as the
 * conversation key so creation is retry-safe). Minted once and persisted
 * on the entry so every session shares one conversation.
 */
export function resolveConversationKey(entry: AssistantEntry): string {
  if (entry.conversationKey) return entry.conversationKey;
  const minted = crypto.randomUUID();
  saveAssistantEntry({ ...entry, conversationKey: minted });
  return minted;
}

/**
 * Scan upward from `basePort` to find an available port. A port is considered
 * available when `probePort()` returns false (nothing listening). Scans up to
 * 100 ports above the base before giving up.
 */
async function findAvailablePort(
  basePort: number,
  excludedPorts: number[] = [],
): Promise<number> {
  const maxOffset = 100;
  for (let offset = 0; offset < maxOffset; offset++) {
    const port = basePort + offset;
    if (excludedPorts.includes(port)) continue;
    const inUse = await probePort(port);
    if (!inUse) return port;
  }
  throw new Error(
    `Could not find an available port scanning from ${basePort} to ${basePort + maxOffset - 1}`,
  );
}

/**
 * Allocate an isolated set of resources for a named local instance.
 * Every new local assistant is allocated under
 * `$XDG_DATA_HOME/cadet{-env}/assistants/<name>/`. The legacy `~/.cadet/`
 * path is only reached via existing lockfile entries from before this change
 * — the read path honors whatever `resources.instanceDir` is stored, so
 * production users' existing first-local assistants keep their `~/.cadet/`
 * roots unchanged.
 */
export async function allocateLocalResources(
  instanceName: string,
): Promise<LocalInstanceResources> {
  const env = getCurrentEnvironment();
  const instanceDir = join(getMultiInstanceDir(env), instanceName);
  mkdirSync(instanceDir, { recursive: true });

  // Collect ports already assigned to other local instances in the lockfile.
  const reservedPorts: number[] = [];
  for (const entry of loadAllAssistants()) {
    if (entry.cloud !== "local" || !entry.resources) continue;
    reservedPorts.push(
      entry.resources.daemonPort,
      entry.resources.gatewayPort,
      entry.resources.qdrantPort,
      entry.resources.cesPort,
    );
  }

  // Env-aware bases: non-prod envs sit in their own 1000-port window so
  // running prod and staging assistants side-by-side doesn't collide. See
  // the `@mycadet/environments` `portBlock` layout.
  const basePorts = getDefaultPorts(env);
  const daemonPort = await findAvailablePort(basePorts.daemon, reservedPorts);
  const gatewayPort = await findAvailablePort(basePorts.gateway, [
    ...reservedPorts,
    daemonPort,
  ]);
  const qdrantPort = await findAvailablePort(basePorts.qdrant, [
    ...reservedPorts,
    daemonPort,
    gatewayPort,
  ]);
  const cesPort = await findAvailablePort(basePorts.ces, [
    ...reservedPorts,
    daemonPort,
    gatewayPort,
    qdrantPort,
  ]);

  return {
    instanceDir,
    daemonPort,
    gatewayPort,
    qdrantPort,
    cesPort,
  };
}

/**
 * Return `cloudBaseUrl` from the lockfile, if set. This is the value
 * persisted by {@link syncConfigToLockfile} the last time the active
 * assistant was hatched/waked, and is the source of truth for "which
 * platform does the currently-active assistant target".
 */
export function getLockfilePlatformBaseUrl(): string | undefined {
  const lockfile = readLockfile();
  const url = lockfile.cloudBaseUrl;
  if (typeof url === "string" && url.trim()) return url.trim();
  return undefined;
}
