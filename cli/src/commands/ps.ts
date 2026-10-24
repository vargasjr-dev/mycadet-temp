import { getNginxIngressPort } from "../lib/nginx-ingress.js";
import { getIngressPaths, readIngressState } from "../lib/nginx-ingress.js";
import { cliCommand } from "../lib/cli-name.js";
import { isCloudHome } from "../lib/cloud-values.js";
import { join } from "path";

import {
  TUNNEL_PROVIDERS,
  type TunnelProviderName,
} from "@mycadet/service-contracts/ingress";
import { DEFAULT_TUNNEL_PROVIDER, toLocalTunnelTarget } from "../lib/tunnel.js";
import { getDefaultWorkspaceDir } from "../lib/ingress-config.js";
import { loadNgrokDomain } from "../lib/tunnels/ngrok.js";
import { getLogDir } from "../lib/xdg-log.js";

import {
  extractHostFromEntry,
  findAssistantByName,
  formatAssistantLookupError,
  getActiveAssistant,
  getAssistantDisplayName,
  getDaemonPidPath,
  getLocalInstanceDir,
  loadAllAssistants,
  lookupAssistantByIdentifier,
  readRootProcesses,
  type LockfileAssistant,
} from "../lib/assistant-config";
import type { LocalAssistantResources } from "@mycadet/local-mode/contract";
import { getGatewayUrl } from "../lib/runtime-url.js";
import { parseAssistantTargetArg } from "../lib/assistant-target-args.js";
import { resolveEnvironmentSource } from "../lib/environments/resolve";
import { loadGuardianToken } from "../lib/guardian-token";
import {
  checkCloudHealth,
  checkHealth,
  fetchCloudPs,
  fetchGatewayPs,
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

/**
 * What each row's `type` column says: the KIND of process the row describes.
 * Assistant's emoji is a single code point (🤖, same class as 🚇/🌐) on
 * purpose: ZWJ sequences compose into one glyph in Terminal.app but render
 * as TWO glyphs in VSCode's xterm.js — eating an extra 2 cells and shoving
 * every later column out of alignment (the 🧑‍🚀 incident).
 */
const ASSISTANT_TYPE = "🤖 Assistant";
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

async function getRemoteProcessesCustom(
  entry: LockfileAssistant,
): Promise<string> {
  const host = extractHostFromEntry(entry);
  return execOutput("ssh", [...SSH_OPTS, `root@${host}`, REMOTE_PS_CMD], {
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

async function getLocalProcesses(
  entry: LockfileAssistant,
): Promise<TableRow[]> {
  const resources = entry.resources;
  if (!resources) {
    throw new Error(
      `Local assistant '${entry.assistantId}' is missing resource configuration. Re-hatch to fix.`,
    );
  }
  const cadetDir = getLocalInstanceDir(resources);
  const gatewayUrl = getGatewayUrl(entry);
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
  resources: LocalAssistantResources,
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
      port: 0,
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

async function getDockerProcesses(
  entry: LockfileAssistant,
): Promise<TableRow[]> {
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

function locationFor(entry: LockfileAssistant): string {
  if (entry.cloud === "local") {
    return entry.resources?.instanceDir ?? "unknown — no instance dir recorded";
  }
  if (entry.cloud === "docker") {
    return `docker container ${dockerResourceNames(entry.assistantId).assistantContainer}`;
  }
  return entry.runtimeUrl ?? "unknown — no runtime URL recorded";
}

async function getAssistantProcessRows(
  entry: LockfileAssistant,
): Promise<TableRow[]> {
  const cloud = entry.cloud;

  console.log(`Processes for ${getAssistantDisplayName(entry)} — ${cloud}:`);
  console.log(`Location: ${locationFor(entry)}\n`);

  if (cloud === "local") {
    return getLocalProcesses(entry);
  }

  if (cloud === "docker") {
    return getDockerProcesses(entry);
  }

  if (isCloudHome(cloud)) {
    console.log(`  Cadet Cloud ID: ${entry.assistantId}\n`);

    const psData = await fetchCloudPs(entry);

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
    const mgmtSocket = entry.mgmtSocket;
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

  let output: string;
  try {
    if (cloud === "custom") {
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
 * stale entry reads as not running rather than as a lie. The edge carries
 * the assistant it fronts; the tunnel fronts the App Server, not an
 * assistant, so its row renders unattributed. The INFO column leads with
 * the URL the process serves — the tunnel's public URL, the edge's loopback
 * listen URL — the same way assistant rows lead with their runtime URL. The
 * app entry may carry only its built-sha stamp between runs; such an entry
 * reports no row.
 */
async function getRootManagedRows(): Promise<RootManagedRow[]> {
  const { tunnel, app } = readRootProcesses();
  const rows: RootManagedRow[] = [];

  if (tunnel) {
    const alive = isLocalProcessAlive(tunnel.pid);
    const info = [tunnel.publicUrl, `PID ${tunnel.pid}`]
      .filter(Boolean)
      .join(" | ");
    rows.push({
      row: {
        name: tunnel.provider ?? "unknown provider",
        type: TUNNEL_TYPE,
        status: withStatusEmoji(alive ? "running" : "not running"),
        info: alive ? info : `${info} (exited)`,
      },
    });
  }
  if (app?.pid !== undefined) {
    const alive = isLocalProcessAlive(app.pid);
    const listenUrl = `http://127.0.0.1:${app.port ?? getNginxIngressPort()}`;
    const info = [listenUrl, `PID ${app.pid}`].join(" | ");
    rows.push({
      assistantId: app.assistantId,
      row: {
        name: "nginx",
        type: APP_TYPE,
        status: withStatusEmoji(alive ? "running" : "not running"),
        info: alive ? info : `${info} (exited)`,
      },
    });
  }
  return rows;
}

// ── Root-managed process detail views ───────────────────────────

function detailLine(label: string, value: string | null | undefined): void {
  console.log(`  ${label.padEnd(17)}${value ?? "—"}`);
}

/** The workspace the edge fronting `assistantId` lives in, or the default. */
function edgeWorkspaceFor(assistantId: string | undefined): string {
  if (assistantId) {
    const result = lookupAssistantByIdentifier(assistantId);
    if (result.status === "found") {
      const target = toLocalTunnelTarget(result.entry);
      if (target) return target.workspaceDir;
    }
  }
  return getDefaultWorkspaceDir();
}

/**
 * Full info for one CLI-managed process: `cadet ps nginx` / `cadet app status`
 * (the app edge) and `cadet ps ngrok` / `cadet tunnel status` (the tunnel
 * agent — any provider name, or "tunnel"). These names resolve before
 * assistant lookup: a built-in process name wins. Returns false when the
 * identifier names neither, so the caller falls through to the assistant
 * lookup.
 */
export async function printRootProcessDetail(
  identifier: string,
): Promise<boolean> {
  const name = identifier.toLowerCase();
  const { tunnel, app } = readRootProcesses();

  if (name === "nginx" || name === "app") {
    console.log("App edge (nginx):");
    if (!app?.pid) {
      console.log(
        `  not recorded — start one with \`${cliCommand()} app start\``,
      );
      return true;
    }
    const alive = isLocalProcessAlive(app.pid);
    const workspaceDir = edgeWorkspaceFor(app.assistantId);
    const state = readIngressState(workspaceDir);
    detailLine("Status:", alive ? "running" : "not running");
    detailLine("PID:", String(app.pid));
    detailLine(
      "Listen:",
      `http://127.0.0.1:${app.port ?? state?.listenPort ?? getNginxIngressPort()}`,
    );
    detailLine(
      "Gateway:",
      state?.gatewayPort !== undefined
        ? `127.0.0.1:${state.gatewayPort}`
        : null,
    );
    detailLine("Assistant:", assistantLabelFor(app.assistantId));
    detailLine("Started:", app.startedAt);
    detailLine("Log:", getIngressPaths(workspaceDir).logPath);
    return true;
  }

  const provider: string | null = tunnel?.provider ?? null;
  if (
    name === "tunnel" ||
    TUNNEL_PROVIDERS.includes(name as TunnelProviderName)
  ) {
    console.log(
      name === "tunnel" ? "Tunnel agent:" : `Tunnel agent (${name}):`,
    );
    if (!tunnel) {
      console.log(
        `  not recorded — start one with \`${cliCommand()} tunnel start\``,
      );
      return true;
    }
    if (name !== "tunnel" && (provider ?? DEFAULT_TUNNEL_PROVIDER) !== name) {
      console.log(
        `  no ${name} tunnel is recorded — the recorded tunnel's provider is ${provider ?? "unknown"}.`,
      );
      return true;
    }
    const alive = isLocalProcessAlive(tunnel.pid);
    detailLine("Status:", alive ? "running" : "not running");
    detailLine("PID:", String(tunnel.pid));
    detailLine("Provider:", provider ?? DEFAULT_TUNNEL_PROVIDER);
    detailLine("URL:", tunnel.publicUrl);
    if ((provider ?? DEFAULT_TUNNEL_PROVIDER) === "ngrok") {
      detailLine("Reserved domain:", loadNgrokDomain());
    }
    detailLine("Started:", tunnel.startedAt);
    detailLine("Log:", join(getLogDir(), "tunnel.log"));
    return true;
  }

  return false;
}

function assistantLabelFor(assistantId: string | undefined): string | null {
  if (!assistantId) return null;
  const result = lookupAssistantByIdentifier(assistantId);
  return result.status === "found"
    ? getAssistantDisplayName(result.entry)
    : assistantId;
}

/**
 * Fold the CLI-managed process rows into ONE table with the assistant rows.
 * Tunnel agents and the nginx edge are root resources of the machine, not
 * children of whichever assistant they front — especially as the web bundle
 * splits into /app and /ui — so every CLI-managed row renders machine-level.
 */
async function assistantRowsWithRootProcesses(
  assistants: LockfileAssistant[],
  healths: AssistantHealth[],
  activeAssistantId: string | null,
): Promise<TableRow[]> {
  const rootRows = (await getRootManagedRows()).map((managed) => managed.row);

  const rows: TableRow[] = [];
  assistants.forEach((entry, i) => {
    rows.push(formatAssistantListRow(entry, activeAssistantId, healths[i]!));
  });
  rows.push(...rootRows);
  return rows;
}

// ── List all assistants (no arg) ────────────────────────────────

type AssistantHealth = {
  status: string;
  detail: string | null;
  version?: string;
};

async function getAssistantListHealth(
  entry: LockfileAssistant,
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
    return checkHealth(getGatewayUrl(entry), token);
  }

  if (entry.cloud === "docker") {
    const res = dockerResourceNames(entry.assistantId);
    const state = await getDockerContainerState(res.assistantContainer);
    if (!state || state !== "running") {
      return { status: "sleeping", detail: null };
    }
    const token = loadGuardianToken(entry.assistantId)?.accessToken;
    return checkHealth(getGatewayUrl(entry), token);
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
    return checkCloudHealth(entry);
  }

  const token = loadGuardianToken(entry.assistantId)?.accessToken;
  return checkHealth(getGatewayUrl(entry), token);
}

function formatAssistantListRow(
  entry: LockfileAssistant,
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
  console.log("");
}

// ── Entry point ─────────────────────────────────────────────────

export const ps = Object.assign(
  async function ps(): Promise<void> {
    const args = process.argv.slice(3);
    if (args.includes("--help") || args.includes("-h")) {
      console.log(`Usage: ${cliCommand()} ps [<name-or-id>] [--verbose]`);
      console.log("");
      console.log(
        "List all assistants, or show processes for a specific assistant.",
      );
      console.log("");
      console.log("Arguments:");
      console.log(
        "  <name-or-id> Show processes for the assistant display name or ID.",
        "               Built-in names show the CLI-managed processes instead:",
        "               `nginx` (the app edge), `ngrok`/`tunnel` (the agent)",
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

    // Built-in process names (`nginx`, `ngrok`, any provider, `tunnel`)
    // detail the CLI-managed processes before assistant lookup — they can
    // never collide with an assistant name worth shadowing.
    if (await printRootProcessDetail(assistantIdentifier)) return;

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
  { description: "List assistants" },
);
