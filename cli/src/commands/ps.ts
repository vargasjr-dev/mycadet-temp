import { isCloudHome } from "../lib/cloud-values.js";
import { join } from "path";

import {
  extractHostFromUrl,
  findAssistantByName,
  formatAssistantLookupError,
  formatAssistantReference,
  getActiveAssistant,
  getAssistantDisplayName,
  getDaemonPidPath,
  loadAllAssistants,
  lookupAssistantByIdentifier,
  readRootProcesses,
  type AssistantEntry,
} from "../lib/assistant-config";
import { parseAssistantTargetArg } from "../lib/assistant-target-args.js";
import { resolveEnvironmentSource } from "../lib/environments/resolve";
import { loadGuardianToken } from "../lib/guardian-token";
import {
  checkHealth,
  checkManagedHealth,
  fetchGatewayPs,
  fetchManagedPs,
  type ManagedProcessEntry,
} from "../lib/health-check";
import { readCloudToken } from "../lib/cloud-client";
import { dockerResourceNames } from "../lib/docker";
import { existsSync } from "fs";
import {
  classifyProcess,
  detectOrphanedProcesses,
  isPidAlive,
  parseRemotePs,
  readPidFile,
} from "../lib/orphan-detection";
import { pgrepExact } from "../lib/pgrep";
import { probePort } from "../lib/port-probe";
import { withStatusEmoji } from "../lib/status-emoji";
import { execOutput } from "../lib/step-runner";
import {
  syncCloudAssistants,
  type SyncLogger,
} from "../lib/sync-cloud-assistants";

// ── Table formatting helpers ────────────────────────────────────

/** What each row's `type` column says: the KIND of process the row describes. */
const ASSISTANT_TYPE = "🧑‍🚀 Assistant";
const TUNNEL_TYPE = "🚇 Tunnel";
const APP_TYPE = "🌐 App";

interface TableRow {
  name: string;
  type: string;
  status: string;
  info: string;
}

interface ColWidths {
  name: number;
  type: number;
  status: number;
  info: number;
}

/**
 * Terminal display width for table alignment: emoji render two cells wide
 * (including ZWJ sequences like 🧑‍🚀 and VS16 pairs like ⚠️), while the ZWJ
 * and variation selectors themselves render zero. `.length` counts UTF-16
 * units and none of that, which is what broke the STATUS and INFO columns
 * whenever an emoji appeared in an earlier one.
 */
export function displayWidth(s: string): number {
  const chars = [...s];
  let width = 0;
  // A ZWJ joins the previous and next glyphs into ONE grapheme (🧑‍🚀 renders
  // as a single 2-cell astronaut), so the glyph after a ZWJ adds no width.
  let joinedByZwj = false;
  for (let i = 0; i < chars.length; i++) {
    const cp = chars[i]?.codePointAt(0) ?? 0;
    // Zero-width: the joiner, the variation selectors, skin-tone modifiers.
    if (cp === 0x200d) {
      joinedByZwj = true;
      continue;
    }
    if (cp === 0xfe0e || cp === 0xfe0f) continue;
    if (cp >= 0x1f3fb && cp <= 0x1f3ff) continue;
    const next = chars[i + 1]?.codePointAt(0);
    if (!joinedByZwj) {
      // A VS16 after a narrow symbol forces emoji presentation — two cells.
      width += isWideCodePoint(cp) || next === 0xfe0f ? 2 : 1;
    }
    joinedByZwj = false;
  }
  return width;
}

function isWideCodePoint(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals and punctuation
    (cp >= 0x3040 && cp <= 0x318f) || // Hiragana, Katakana, bopomofo
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
    (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK compatibility forms
    (cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    cp >= 0x1f000 // emoji and symbol blocks (🟢, 🚀, 🧑, …)
  );
}

function pad(s: string, w: number): string {
  return s + " ".repeat(Math.max(0, w - displayWidth(s)));
}

function computeColWidths(
  rows: TableRow[],
  headers: TableRow = {
    name: "NAME",
    type: "TYPE",
    status: "STATUS",
    info: "INFO",
  },
): ColWidths {
  const all = [headers, ...rows];
  return {
    name: Math.max(...all.map((r) => displayWidth(r.name))),
    type: Math.max(...all.map((r) => displayWidth(r.type))),
    status: Math.max(
      ...all.map((r) => displayWidth(r.status)),
      "checking...".length,
    ),
    info: Math.max(...all.map((r) => displayWidth(r.info))),
  };
}

export function formatRow(r: TableRow, colWidths: ColWidths): string {
  return `  ${pad(r.name, colWidths.name)}  ${pad(r.type, colWidths.type)}  ${pad(r.status, colWidths.status)}  ${r.info}`;
}

function printTable(
  rows: TableRow[],
  headers: TableRow = {
    name: "PROCESS",
    type: "TYPE",
    status: "STATUS",
    info: "INFO",
  },
): void {
  const colWidths = computeColWidths(rows, headers);
  console.log(formatRow(headers, colWidths));
  const sep = `  ${"-".repeat(colWidths.name)}  ${"-".repeat(colWidths.type)}  ${"-".repeat(colWidths.status)}  ${"-".repeat(colWidths.info)}`;
  console.log(sep);
  for (const row of rows) {
    console.log(formatRow(row, colWidths));
  }
}

// ── Managed process tree rendering ──────────────────────────────

const STATUS_LABELS: Record<ManagedProcessEntry["status"], string> = {
  running: "running",
  not_running: "not running",
  unreachable: "unreachable",
};

function flattenProcessTree(
  entries: ManagedProcessEntry[],
  depth = 0,
): TableRow[] {
  const rows: TableRow[] = [];
  for (const entry of entries) {
    const children = entry.children ?? [];

    rows.push({
      name:
        depth === 0 ? entry.name : `${"  ".repeat(depth - 1)}├─ ${entry.name}`,
      type: ASSISTANT_TYPE,
      status: withStatusEmoji(STATUS_LABELS[entry.status]),
      info: entry.info ?? "",
    });

    for (let j = 0; j < children.length; j++) {
      const child = children[j];
      const isLast = j === children.length - 1;
      const prefix = `${"  ".repeat(depth)}${isLast ? "└─" : "├─"} ${child.name}`;
      rows.push({
        name: prefix,
        type: ASSISTANT_TYPE,
        status: withStatusEmoji(STATUS_LABELS[child.status]),
        info: child.info ?? "",
      });

      // Recurse into grandchildren
      const grandchildren = child.children ?? [];
      if (grandchildren.length > 0) {
        rows.push(...flattenProcessTree(grandchildren, depth + 2));
      }
    }
  }
  return rows;
}

// ── Remote process listing via SSH ──────────────────────────────

const SSH_OPTS = [
  "-o",
  "StrictHostKeyChecking=no",
  "-o",
  "UserKnownHostsFile=/dev/null",
  "-o",
  "ConnectTimeout=10",
  "-o",
  "LogLevel=ERROR",
];

const REMOTE_PS_CMD = [
  // List Cadet-related processes: daemon, gateway, qdrant, and any bun children
  "ps ax -o pid=,ppid=,args=",
  "| grep -E 'cadet|qdrant'",
  "| grep -v grep",
].join(" ");

const REMOTE_SSH_TIMEOUT_MS = 30_000;

async function getRemoteProcessesGcp(entry: AssistantEntry): Promise<string> {
  return execOutput(
    "gcloud",
    [
      "compute",
      "ssh",
      `${entry.sshUser ?? entry.assistantId}@${entry.assistantId}`,
      `--zone=${entry.zone}`,
      `--project=${entry.project}`,
      `--command=${REMOTE_PS_CMD}`,
      "--ssh-flag=-o StrictHostKeyChecking=no",
      "--ssh-flag=-o UserKnownHostsFile=/dev/null",
      "--ssh-flag=-o ConnectTimeout=10",
      "--ssh-flag=-o LogLevel=ERROR",
    ],
    { timeoutMs: REMOTE_SSH_TIMEOUT_MS },
  );
}

async function getRemoteProcessesCustom(
  entry: AssistantEntry,
): Promise<string> {
  const host = extractHostFromUrl(entry.runtimeUrl);
  const sshUser = entry.sshUser ?? "root";
  return execOutput("ssh", [...SSH_OPTS, `${sshUser}@${host}`, REMOTE_PS_CMD], {
    timeoutMs: REMOTE_SSH_TIMEOUT_MS,
  });
}

interface ProcessSpec {
  name: string;
  pgrepName: string;
  port: number;
  pidFile: string;
}

interface DetectedProcess {
  name: string;
  pid: string | null;
  port: number;
  running: boolean;
  watch: boolean;
}

const LOCAL_CMD_TIMEOUT_MS = 5_000;

async function isWatchMode(pid: string): Promise<boolean> {
  try {
    const args = await execOutput("ps", ["-p", pid, "-o", "args="], {
      timeoutMs: LOCAL_CMD_TIMEOUT_MS,
    });
    return args.includes("--watch");
  } catch {
    return false;
  }
}

async function detectProcess(spec: ProcessSpec): Promise<DetectedProcess> {
  // Tier 1: pgrep by process title
  const pids = await pgrepExact(spec.pgrepName);
  if (pids.length > 0) {
    const watch = await isWatchMode(pids[0]);
    return {
      name: spec.name,
      pid: pids[0],
      port: spec.port,
      running: true,
      watch,
    };
  }

  // Tier 2: TCP port probe (skip for processes without a port)
  const listening = spec.port > 0 && (await probePort(spec.port));
  if (listening) {
    const filePid = readPidFile(spec.pidFile);
    const watch = filePid ? await isWatchMode(filePid) : false;
    return {
      name: spec.name,
      pid: filePid,
      port: spec.port,
      running: true,
      watch,
    };
  }

  // Tier 3: PID file fallback
  const filePid = readPidFile(spec.pidFile);
  if (filePid && isPidAlive(filePid)) {
    const watch = await isWatchMode(filePid);
    return {
      name: spec.name,
      pid: filePid,
      port: spec.port,
      running: true,
      watch,
    };
  }

  return {
    name: spec.name,
    pid: null,
    port: spec.port,
    running: false,
    watch: false,
  };
}

function formatDetectionInfo(proc: DetectedProcess): string {
  const parts: string[] = [];
  if (proc.pid) parts.push(`PID ${proc.pid}`);
  if (proc.port > 0) parts.push(`port ${proc.port}`);
  if (proc.watch) parts.push("watch");
  return parts.join(" | ");
}

async function getLocalProcesses(entry: AssistantEntry): Promise<TableRow[]> {
  if (!entry.resources) {
    throw new Error(
      `Local assistant '${entry.assistantId}' is missing resource configuration. Re-hatch to fix.`,
    );
  }
  const resources = entry.resources;
  const cadetDir = resources.instanceDir;
  const gatewayUrl = entry.localUrl ?? entry.runtimeUrl;
  const token = loadGuardianToken(entry.assistantId)?.accessToken;

  // Preferred path: the gateway's /v1/ps returns the daemon's REAL process
  // tree (assistant + every child it owns, built from the OS process table)
  // with the gateway's own entry appended — no hard-coded subsystem list to
  // drift out of sync with what the assistant actually spawns.
  const tree = gatewayUrl ? await fetchGatewayPs(gatewayUrl, token) : null;

  const rows: TableRow[] =
    tree && tree.length > 0
      ? flattenProcessTree(tree)
      : await detectLocalProcessesFallback(resources, cadetDir);

  // The credential-executor is a CLI-spawned SIBLING (not a daemon child),
  // so the daemon's process tree can never report it — detect it here.
  const ces = await detectProcess({
    name: "credential-executor",
    pgrepName: "credential-executor",
    port: 0,
    pidFile: join(cadetDir, "ces.pid"),
  });
  rows.push({
    name: "credential-executor",
    type: ASSISTANT_TYPE,
    status: withStatusEmoji(ces.running ? "running" : "not running"),
    info: ces.running ? formatDetectionInfo(ces) : "not detected",
  });

  return rows;
}

// Fallback for when the gateway can't answer /v1/ps (assistant down, or a
// gateway version that predates the route): probe each known process
// directly.
async function detectLocalProcessesFallback(
  resources: NonNullable<AssistantEntry["resources"]>,
  cadetDir: string,
): Promise<TableRow[]> {
  const assistantSpec: ProcessSpec = {
    name: "assistant",
    pgrepName: "cadet-daemon",
    port: resources.daemonPort,
    pidFile: getDaemonPidPath(resources),
  };
  const subSpecs: ProcessSpec[] = [
    {
      name: "├─ qdrant",
      pgrepName: "qdrant",
      port: resources.qdrantPort,
      pidFile: join(cadetDir, "workspace", "data", "qdrant", "qdrant.pid"),
    },
    {
      name: "└─ embed-worker",
      pgrepName: "embed-worker",
      port: 0,
      pidFile: join(cadetDir, "workspace", "embed-worker.pid"),
    },
  ];
  const gatewaySpec: ProcessSpec = {
    name: "gateway",
    pgrepName: "cadet-gateway",
    port: resources.gatewayPort,
    pidFile: join(cadetDir, "gateway.pid"),
  };

  const allSpecs = [assistantSpec, ...subSpecs, gatewaySpec];
  const results = await Promise.all(allSpecs.map(detectProcess));

  return results.map((proc, i) => ({
    name: allSpecs[i].name,
    type: ASSISTANT_TYPE,
    status: withStatusEmoji(proc.running ? "running" : "not running"),
    info: proc.running ? formatDetectionInfo(proc) : "not detected",
  }));
}

async function getDockerContainerState(
  containerName: string,
): Promise<string | null> {
  try {
    const output = await execOutput(
      "docker",
      ["inspect", "--format", "{{.State.Status}}", containerName],
      { timeoutMs: LOCAL_CMD_TIMEOUT_MS },
    );
    return output.trim() || "unknown";
  } catch {
    return null;
  }
}

function isLocalProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function getDockerProcesses(entry: AssistantEntry): Promise<TableRow[]> {
  const res = dockerResourceNames(entry.assistantId);

  const containers: { name: string; containerName: string }[] = [
    { name: "assistant", containerName: res.assistantContainer },
    { name: "gateway", containerName: res.gatewayContainer },
    { name: "credential-executor", containerName: res.cesContainer },
  ];

  const results = await Promise.all(
    containers.map(async ({ name, containerName }) => {
      const state = await getDockerContainerState(containerName);
      if (!state) {
        return {
          name,
          type: ASSISTANT_TYPE,
          status: withStatusEmoji("not found"),
          info: `container ${containerName}`,
        };
      }
      return {
        name,
        type: ASSISTANT_TYPE,
        status: withStatusEmoji(state === "running" ? "running" : state),
        info: `container ${containerName}`,
      };
    }),
  );

  // Show the file watcher process if the instance was hatched with --watch.
  const watcherPid =
    typeof entry.watcherPid === "number" ? entry.watcherPid : null;
  if (watcherPid !== null) {
    const alive = isLocalProcessAlive(watcherPid);
    results.push({
      name: "file-watcher",
      type: ASSISTANT_TYPE,
      status: withStatusEmoji(alive ? "running" : "not running"),
      info: alive ? `PID ${watcherPid}` : "not detected",
    });
  }

  return results;
}

function locationFor(entry: AssistantEntry): string {
  if (entry.cloud === "local") {
    return entry.resources?.instanceDir ?? "unknown — no instance dir recorded";
  }
  if (entry.cloud === "docker") {
    return `docker container ${dockerResourceNames(entry.assistantId).assistantContainer}`;
  }
  return entry.runtimeUrl ?? "unknown — no runtime URL recorded";
}

async function getAssistantProcessRows(
  entry: AssistantEntry,
): Promise<TableRow[]> {
  const cloud = entry.cloud;

  console.log(`Processes for ${formatAssistantReference(entry)} (${cloud}):`);
  console.log(`Location: ${locationFor(entry)}\n`);

  if (cloud === "local") {
    return getLocalProcesses(entry);
  }

  if (cloud === "docker") {
    return getDockerProcesses(entry);
  }

  if (isCloudHome(cloud)) {
    console.log(`  Cadet Cloud ID: ${entry.assistantId}\n`);

    const psData = await fetchManagedPs(entry.runtimeUrl, entry.assistantId);

    if (!psData) {
      return [
        {
          name: "assistant",
          type: ASSISTANT_TYPE,
          status: withStatusEmoji("unreachable"),
          info: "could not reach Cadet Cloud API — run `cadet login`",
        },
      ];
    }

    return flattenProcessTree(psData.processes);
  }

  if (cloud === "apple-container") {
    const mgmtSocket = entry.mgmtSocket as string | undefined;
    const socketAlive = mgmtSocket ? existsSync(mgmtSocket) : false;
    const rows: TableRow[] = [
      {
        name: "container",
        type: ASSISTANT_TYPE,
        status: withStatusEmoji(socketAlive ? "running" : "not running"),
        info: socketAlive
          ? `mgmt ${mgmtSocket}`
          : "management socket not found",
      },
    ];
    if (entry.runtimeUrl) {
      const token = loadGuardianToken(entry.assistantId)?.accessToken;
      const health = await checkHealth(entry.runtimeUrl, token);
      rows.push({
        name: "gateway",
        type: ASSISTANT_TYPE,
        status: withStatusEmoji(health.status),
        info: entry.runtimeUrl + (health.detail ? ` | ${health.detail}` : ""),
      });
    }
    return rows;
  }

  if (cloud === "paired") {
    // A remote assistant paired from another machine: no local process to
    // list — probe the remote gateway's health over the bearer token instead.
    const token = loadGuardianToken(entry.assistantId)?.accessToken;
    const health = await checkHealth(entry.runtimeUrl, token);
    return [
      {
        name: "gateway",
        type: ASSISTANT_TYPE,
        status: withStatusEmoji(health.status),
        info: entry.runtimeUrl + (health.detail ? ` | ${health.detail}` : ""),
      },
    ];
  }

  let output: string;
  try {
    if (cloud === "gcp") {
      output = await getRemoteProcessesGcp(entry);
    } else if (cloud === "custom") {
      output = await getRemoteProcessesCustom(entry);
    } else {
      console.error(`Unsupported cloud type '${cloud}' for process listing.`);
      process.exit(1);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("timed out")) {
      console.warn(`Warning: remote process listing timed out — ${msg}`);
      return [];
    }
    console.error(`Failed to list processes: ${msg}`);
    process.exit(1);
  }

  const procs = parseRemotePs(output);

  if (procs.length === 0) {
    console.log("No cadet processes found on the remote instance.");
    return [];
  }

  return procs.map((p) => ({
    name: classifyProcess(p.command),
    type: ASSISTANT_TYPE,
    status: withStatusEmoji("running"),
    info: `PID ${p.pid} | ${p.command.slice(0, 80)}`,
  }));
}

// ── Root-managed process rows (tunnel agent, app edge) ──────────

/** A CLI-managed process row, plus the assistant it fronts (when recorded). */
interface RootManagedRow {
  row: TableRow;
  assistantId?: string;
}

/**
 * Rows for the CLI-managed processes recorded at the lockfile root: the
 * `tunnel` agent and the `app` nginx edge. Pids are liveness-checked so a
 * stale entry reads as not running rather than as a lie. Each row carries the
 * assistant it fronts so the listing can nest it under that assistant.
 */
async function getRootManagedRows(): Promise<RootManagedRow[]> {
  const { tunnel, app } = readRootProcesses();
  const rows: RootManagedRow[] = [];

  if (tunnel) {
    const alive = isLocalProcessAlive(tunnel.pid);
    rows.push({
      assistantId: tunnel.assistantId,
      row: {
        name: tunnel.provider ?? "unknown provider",
        type: TUNNEL_TYPE,
        status: withStatusEmoji(alive ? "running" : "not running"),
        info: alive ? `PID ${tunnel.pid}` : `PID ${tunnel.pid} (exited)`,
      },
    });
  }
  if (app) {
    const alive = isLocalProcessAlive(app.pid);
    rows.push({
      assistantId: app.assistantId,
      row: {
        name: "nginx edge",
        type: APP_TYPE,
        status: withStatusEmoji(alive ? "running" : "not running"),
        info: alive ? `PID ${app.pid}` : `PID ${app.pid} (exited)`,
      },
    });
  }
  return rows;
}

/**
 * Fold the CLI-managed process rows into ONE table with the assistant rows:
 * a process fronts an assistant when it recorded that assistant's id, and
 * those rows nest under it; anything unattributed (or fronting an assistant
 * this environment no longer lists) renders at the bottom, machine-level.
 */
async function assistantRowsWithRootProcesses(
  assistants: AssistantEntry[],
  healths: AssistantHealth[],
  activeAssistantId: string | null,
): Promise<TableRow[]> {
  const nestedByAssistant = new Map<string, TableRow[]>();
  const unattributed: TableRow[] = [];
  const knownIds = new Set(assistants.map((entry) => entry.assistantId));
  for (const managed of await getRootManagedRows()) {
    if (managed.assistantId && knownIds.has(managed.assistantId)) {
      const nested = nestedByAssistant.get(managed.assistantId) ?? [];
      nested.push({ ...managed.row, name: `  └ ${managed.row.name}` });
      nestedByAssistant.set(managed.assistantId, nested);
    } else {
      unattributed.push(managed.row);
    }
  }

  const rows: TableRow[] = [];
  assistants.forEach((entry, i) => {
    rows.push(formatAssistantListRow(entry, activeAssistantId, healths[i]!));
    rows.push(...(nestedByAssistant.get(entry.assistantId) ?? []));
  });
  rows.push(...unattributed);
  return rows;
}

// ── List all assistants (no arg) ────────────────────────────────

type AssistantHealth = {
  status: string;
  detail: string | null;
  version?: string;
};

async function getAssistantListHealth(
  entry: AssistantEntry,
): Promise<AssistantHealth> {
  const resources = entry.resources;
  if (entry.cloud === "local" && resources) {
    // TODO(ATL-306): Remove readPidFile/getDaemonPidPath in favor of
    // fetching daemon PIDs via the health API (Gateway Security Migration).
    const pid = readPidFile(getDaemonPidPath(resources));
    const alive = pid !== null && isPidAlive(pid);
    if (!alive) {
      return { status: "sleeping", detail: null };
    }
    const token = loadGuardianToken(entry.assistantId)?.accessToken;
    return checkHealth(entry.localUrl ?? entry.runtimeUrl, token);
  }

  if (entry.cloud === "docker") {
    const res = dockerResourceNames(entry.assistantId);
    const state = await getDockerContainerState(res.assistantContainer);
    if (!state || state !== "running") {
      return { status: "sleeping", detail: null };
    }
    const token = loadGuardianToken(entry.assistantId)?.accessToken;
    return checkHealth(entry.localUrl ?? entry.runtimeUrl, token);
  }

  if (entry.cloud === "apple-container") {
    // Apple containers are managed by the macOS app. Probe the gateway
    // (runtimeUrl is always written to the lockfile during hatch).
    const token = loadGuardianToken(entry.assistantId)?.accessToken;
    return entry.runtimeUrl
      ? checkHealth(entry.runtimeUrl, token)
      : { status: "unknown", detail: "no runtime URL" };
  }

  if (isCloudHome(entry.cloud)) {
    return checkManagedHealth(entry.runtimeUrl, entry.assistantId);
  }

  const token = loadGuardianToken(entry.assistantId)?.accessToken;
  return checkHealth(entry.localUrl ?? entry.runtimeUrl, token);
}

function formatAssistantListRow(
  entry: AssistantEntry,
  activeAssistantId: string | null,
  health: AssistantHealth,
): TableRow {
  const infoParts: string[] = [];
  if (entry.runtimeUrl) infoParts.push(entry.runtimeUrl);
  if (entry.cloud) infoParts.push(`remote: ${entry.cloud}`);
  if (health.detail) infoParts.push(health.detail);

  const prefix = entry.assistantId === activeAssistantId ? "* " : "  ";
  return {
    name: prefix + getAssistantDisplayName(entry),
    type: ASSISTANT_TYPE,
    status: withStatusEmoji(health.status),
    info: infoParts.join(" | "),
  };
}

export async function listAllAssistants(verbose: boolean): Promise<void> {
  const { name: envName } = resolveEnvironmentSource();
  // Production is what everyone gets by default — saying so is noise. Only
  // surface the line when the environment differs from the default.
  if (envName !== "production") {
    console.log(`Environment: ${envName}`);
  }

  const log: SyncLogger | undefined = verbose
    ? (msg) => console.log(`  [verbose] ${msg}`)
    : undefined;

  // Sync cloud assistants (when logged in) before listing. Login status has
  // its own command — `cadet whoami` — so ps stays silent about it.
  const cloudToken = readCloudToken();
  if (!cloudToken) {
    log?.("No platform token found — skipping cloud sync");
  } else {
    // A failed sync (offline, expired token) just means cloud-managed
    // assistants may be stale — the local list still renders.
    await syncCloudAssistants(cloudToken, { log });
  }
  console.log("");

  const assistants = loadAllAssistants();
  const activeId = getActiveAssistant();
  const activeAssistantId = activeId
    ? (findAssistantByName(activeId)?.assistantId ?? activeId)
    : null;

  if (assistants.length === 0) {
    console.log("No assistants found.");

    const orphans = await detectOrphanedProcesses();
    if (orphans.length > 0) {
      console.log("\nOrphaned processes detected:\n");
      const rows: TableRow[] = orphans.map((o) => ({
        name: o.name,
        type: ASSISTANT_TYPE,
        status: withStatusEmoji("running"),
        info: `PID ${o.pid} (from ${o.source})`,
      }));
      printTable(rows);
      console.log(
        `\nHint: Run \`cadet clean\` to clean up orphaned processes.`,
      );
    }

    return;
  }

  const healths = await Promise.all(
    assistants.map((entry) => getAssistantListHealth(entry)),
  );

  printTable(
    await assistantRowsWithRootProcesses(
      assistants,
      healths,
      activeAssistantId,
    ),
    { name: "NAME", type: "TYPE", status: "STATUS", info: "INFO" },
  );
}

// ── Entry point ─────────────────────────────────────────────────

export const ps = Object.assign(
  async function ps(): Promise<void> {
    const args = process.argv.slice(3);
    if (args.includes("--help") || args.includes("-h")) {
      console.log("Usage: cadet ps [<name-or-id>] [--verbose]");
      console.log("");
      console.log(
        "List all assistants, or show processes for a specific assistant.",
      );
      console.log("");
      console.log("Arguments:");
      console.log(
        "  <name-or-id> Show processes for the assistant display name or ID",
      );
      console.log("");
      console.log("Options:");
      console.log(
        "  --verbose    Show diagnostic logs (platform sync, auth issues)",
      );
      process.exit(0);
    }

    const verbose = args.includes("--verbose");
    const assistantIdentifier = parseAssistantTargetArg(args);

    if (!assistantIdentifier) {
      await listAllAssistants(verbose);
      return;
    }

    const result = lookupAssistantByIdentifier(assistantIdentifier);
    if (result.status !== "found") {
      console.error(formatAssistantLookupError(assistantIdentifier, result));
      process.exit(1);
    }

    const rows = await getAssistantProcessRows(result.entry);
    // The CLI-managed processes (root lockfile) that front THIS assistant ride
    // the same table; ones fronting another assistant stay in the list view.
    for (const managed of await getRootManagedRows()) {
      if (
        managed.assistantId &&
        managed.assistantId !== result.entry.assistantId
      ) {
        continue;
      }
      rows.push(managed.row);
    }
    printTable(rows);
  },
  { description: "List assistants (or processes for a specific assistant)" },
);
