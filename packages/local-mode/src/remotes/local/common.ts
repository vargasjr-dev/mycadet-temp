import { execFileSync, spawn, execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { Socket } from "node:net";
import { homedir, platform } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";

import { getLocalSourceRoot } from "../../source-root";

import {
  isNamedPipePath,
  removeIpcEndpointFile,
  resolveIpcEndpoint,
} from "@mycadet/ipc-server-utils";

import { resolveDataDir, resolveLogDir } from "../../config";
import { GATEWAY_PORT, type LocalAssistant } from "../../lockfile-contract";
import { waitForDaemonReady } from "../../daemon-readiness";
import { getDefaultPorts, findAvailablePort } from "../../ports";
import {
  executableName,
  isProcessAlive,
  pathListDelimiter,
  stopProcessByPidFile,
} from "../../process";
import { isValidReleaseVersion } from "../../upgrade";
import { stripVersionPrefix } from "../../version";
import {
  closeLogFile,
  openLogFile,
  openRuntimeLogFile,
  pipeToLogFile,
} from "../../xdg-log";
import {
  getDaemonPidPath,
  getGatewayPidPath,
  getLocalInstanceDir,
} from "./instance";

const _require = createRequire(import.meta.url);

const LOCAL_RUNTIME_PACKAGE = "mycadet";
const PATH_DELIMITER = pathListDelimiter(platform());
const DEFAULT_EXECUTABLE_PATH =
  platform() === "win32"
    ? "C:\\Windows\\System32;C:\\Windows"
    : "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

/**
 * cwd for every service spawn — the XDG data home
 * (`$XDG_DATA_HOME/cadet[-<env>]`, i.e. `~/.local/share/cadet`). The spawner
 * picks where services run so their `process.cwd()`-fallback state dirs
 * resolve under XDG and never into a checkout (the repo root included);
 * containerized deployments set explicit env vars instead.
 */
function spawnStateRoot(): string {
  // Bare-metal fallback root for machine-scoped Cadet state: the XDG data
  // home (`$XDG_DATA_HOME/cadet[-<env>]`, i.e. `~/.local/share/cadet` in
  // production). Spawn paths without an instance entry (watch mode, repair
  // flows) land here instead of the retired `~/.cadet` root.
  const root = resolveDataDir();
  mkdirSync(root, { recursive: true });
  return root;
}

export interface LocalRuntimeInstall {
  version: string;
  installDir: string;
}

function normalizeRuntimeVersion(version: string): string {
  return version === "latest" ? version : stripVersionPrefix(version);
}

function sharedRuntimeRoot(): string {
  const bunGlobalDir =
    process.env.BUN_INSTALL_GLOBAL_DIR ||
    join(
      process.env.BUN_INSTALL || join(homedir(), ".bun"),
      "install",
      "global",
    );
  return resolve(bunGlobalDir, "cadet-runtimes");
}

function packagePath(
  installDir: string,
  packageName: string,
  relativePath: string,
): string {
  return join(
    installDir,
    "node_modules",
    ...packageName.split("/"),
    relativePath,
  );
}

function hasLocalRuntimeComponents(installDir: string): boolean {
  return (
    existsSync(packagePath(installDir, "@mycadet/assistant", "src/index.ts")) &&
    existsSync(packagePath(installDir, "@mycadet/gateway", "src/index.ts")) &&
    existsSync(
      packagePath(installDir, "@mycadet/credential-executor", "src/main.ts"),
    )
  );
}

export function resolveBunExecutable(): string {
  const envBun = process.env.CADET_BUN;
  if (envBun && existsSync(envBun)) return envBun;

  const bunName = executableName("bun", platform());
  // Packaged runtimes bundle bun at the runtime root, beside the product
  // source the CLI executes.
  const bundledSiblingBun = join(dirname(process.execPath), bunName);
  if (existsSync(bundledSiblingBun)) return bundledSiblingBun;

  const bundledBun = join(
    dirname(process.execPath),
    "..",
    "Resources",
    bunName,
  );
  if (existsSync(bundledBun)) return bundledBun;

  const homeBun = join(homedir(), ".bun", "bin", bunName);
  if (existsSync(homeBun)) return homeBun;

  return bunName;
}

function envWithBunPath(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const bunPath = resolveBunExecutable();
  const basePath = env.PATH || DEFAULT_EXECUTABLE_PATH;
  const extraDirs = [
    isAbsolute(bunPath) ? dirname(bunPath) : "",
    join(homedir(), ".bun", "bin"),
    join(homedir(), ".local", "bin"),
  ].filter((dir) => dir && !basePath.split(PATH_DELIMITER).includes(dir));
  return {
    ...env,
    PATH: [...extraDirs, basePath].filter(Boolean).join(PATH_DELIMITER),
  };
}

function localRuntimeAssistantIndex(entry: LocalAssistant): string | undefined {
  const installDir = latestLocalRuntimeInstallDir(entry);
  if (!installDir) return undefined;
  const candidate = packagePath(
    installDir,
    "@mycadet/assistant",
    "src/index.ts",
  );
  return existsSync(candidate) ? candidate : undefined;
}

function localRuntimeGatewayDir(
  entry: LocalAssistant | undefined,
): string | undefined {
  const installDir = entry && latestLocalRuntimeInstallDir(entry);
  if (!installDir) return undefined;
  const candidate = packagePath(installDir, "@mycadet/gateway", "");
  return isGatewaySourceDir(candidate) ? candidate : undefined;
}

function localRuntimeCesDir(
  entry: LocalAssistant | undefined,
): string | undefined {
  const installDir = entry && latestLocalRuntimeInstallDir(entry);
  if (!installDir) return undefined;
  const candidate = packagePath(installDir, "@mycadet/credential-executor", "");
  return isCesSourceDir(candidate) ? candidate : undefined;
}

/**
 * The instance's most recently installed self-managed runtime — the newest
 * entry under `<instanceDir>/runtime/`. New entries are links to shared
 * installs. Older installs are directories. Use the local entry’s timestamp
 * so another assistant’s install cannot change this assistant’s selection.
 */
function latestLocalRuntimeInstallDir(
  entry: LocalAssistant,
): string | undefined {
  const runtimeRoot = join(getLocalInstanceDir(entry), "runtime");
  let installed: string[];
  try {
    installed = readdirSync(runtimeRoot);
  } catch {
    return undefined;
  }
  let newest: { dir: string; mtimeMs: number } | undefined;
  for (const dir of installed) {
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(join(runtimeRoot, dir));
    } catch {
      continue;
    }
    if (!stat.isDirectory() && !stat.isSymbolicLink()) continue;
    if (!newest || stat.mtimeMs > newest.mtimeMs) {
      newest = { dir, mtimeMs: stat.mtimeMs };
    }
  }
  return newest ? join(runtimeRoot, newest.dir) : undefined;
}

export async function ensureLocalRuntime(
  entry: LocalAssistant,
  version: string,
  options: { force?: boolean } = {},
): Promise<LocalRuntimeInstall> {
  // Reject anything that is not a trusted release identifier BEFORE it becomes
  // a filesystem path segment or a `bun install` dependency spec. Without this,
  // a package-manager spec (npm alias, tarball/git URL) or a `../`-laden string
  // reaching this sink would install and then execute arbitrary attacker code
  // as the local assistant runtime. Shares the validator with the host-bridge
  // boundary guard (`runUpgrade`) so the two can never drift.
  if (!isValidReleaseVersion(version)) {
    throw new Error(
      `Invalid runtime version '${version}': expected a release tag like v1.2.3 or 'latest'.`,
    );
  }

  const normalizedVersion = normalizeRuntimeVersion(version);
  const displayVersion =
    normalizedVersion === "latest" ? "latest" : `v${normalizedVersion}`;
  const root = sharedRuntimeRoot();
  const sharedDir = join(root, normalizedVersion);
  let runtimeDir = sharedDir;
  if (options.force || !hasLocalRuntimeComponents(sharedDir)) {
    mkdirSync(root, { recursive: true });
    const stagingDir = mkdtempSync(join(root, `${normalizedVersion}-`));
    try {
      await installLocalRuntime(stagingDir, normalizedVersion, displayVersion);
      if (options.force) {
        // Other assistants may still be running the previous copy.
        runtimeDir = stagingDir;
      } else {
        try {
          renameSync(stagingDir, sharedDir);
        } catch (error) {
          if (!hasLocalRuntimeComponents(sharedDir)) throw error;
          // Another process installed this release while we were downloading.
        }
      }
    } finally {
      if (runtimeDir !== stagingDir) {
        rmSync(stagingDir, { recursive: true, force: true });
      }
    }
  }

  const instanceRuntimeDir = join(getLocalInstanceDir(entry), "runtime");
  mkdirSync(instanceRuntimeDir, { recursive: true });
  const installDir = join(
    instanceRuntimeDir,
    `${normalizedVersion}-${randomUUID()}`,
  );
  symlinkSync(runtimeDir, installDir, "junction");
  return { version: displayVersion, installDir };
}

async function installLocalRuntime(
  installDir: string,
  normalizedVersion: string,
  displayVersion: string,
): Promise<void> {
  ensureBunInstalled();
  mkdirSync(installDir, { recursive: true });
  writeFileSync(
    join(installDir, "package.json"),
    `${JSON.stringify(
      {
        private: true,
        dependencies: {
          [LOCAL_RUNTIME_PACKAGE]: normalizedVersion,
        },
      },
      null,
      2,
    )}\n`,
  );

  const bunPath = resolveBunExecutable();
  const log = openLogFile("runtime-install.log");
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(bunPath, ["install", "--ignore-scripts"], {
        cwd: installDir,
        stdio: ["ignore", log, log],
        env: envWithBunPath(process.env),
        windowsHide: true,
      });
      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (code === 0) resolve();
        else
          reject(
            new Error(`bun install exited with ${signal ?? `code ${code}`}`),
          );
      });
    });
    if (!hasLocalRuntimeComponents(installDir)) {
      throw new Error(
        "Installed runtime is missing assistant, gateway, or credential-executor source.",
      );
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const logHint =
      log === "ignore"
        ? ""
        : ` See ${join(resolveLogDir(), "runtime-install.log")}.`;
    throw new Error(
      `Local runtime install failed (${displayVersion}): ${detail}${logHint}`,
    );
  } finally {
    closeLogFile(log);
  }
}

/**
 * Pin the gateway IPC socket directory to a short, per-instance path —
 * matching the docker topology, which mounts `GATEWAY_IPC_SOCKET_DIR`
 * (`/run/gateway-ipc`) on both the assistant and gateway containers.
 *
 * Local assistants previously resolved `gateway.sock` from the workspace
 * path and only pinned an override dir when that path exceeded macOS's
 * 103-byte AF_UNIX cap, so the resolved path drifted between processes
 * (and from the docker convention). Always pinning
 * `<instanceDir>/ipc/gateway.sock` in BOTH the assistant and gateway envs
 * keeps the two sides in exact agreement and far under the socket path
 * limit.
 */
function applyIpcSocketDirOverride(
  env: Record<string, string | undefined>,
): void {
  const workspaceDir =
    env.CADET_WORKSPACE_DIR || join(resolveDataDir(), "workspace");
  const instanceDir = dirname(workspaceDir);
  const override = join(instanceDir, "ipc");
  try {
    mkdirSync(override, { recursive: true });
  } catch {
    // Fall through: the gateway/assistant envs still carry the pinned dir;
    // the socket bind error surfaces at startup if the dir is unwritable.
  }
  env.GATEWAY_IPC_SOCKET_DIR = override;
}

function isAssistantSourceDir(dir: string): boolean {
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath) || !existsSync(join(dir, "src", "index.ts")))
    return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return pkg.name === "@mycadet/assistant";
  } catch {
    return false;
  }
}

function findAssistantSourceFrom(startDir: string): string | undefined {
  let current = startDir;
  while (true) {
    if (isAssistantSourceDir(current)) {
      return current;
    }
    const nestedCandidate = join(current, "assistant");
    if (isAssistantSourceDir(nestedCandidate)) {
      return nestedCandidate;
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function isGatewaySourceDir(dir: string): boolean {
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath) || !existsSync(join(dir, "src", "index.ts")))
    return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return pkg.name === "@mycadet/gateway";
  } catch {
    return false;
  }
}

/**
 * Walk up from a start dir probing for the credential-executor source: the
 * dir itself (the reported root may BE the package) or a
 * `credential-executor/` child at each level (the repo root layout). The
 * same shape findAssistantSourceFrom uses, because the anchors that find
 * one find the other.
 */
function findCesSourceFrom(startDir: string): string | undefined {
  let current = startDir;
  while (true) {
    if (isCesSourceDir(current)) {
      return current;
    }
    const nestedCandidate = join(current, "credential-executor");
    if (isCesSourceDir(nestedCandidate)) {
      return nestedCandidate;
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function isCesSourceDir(dir: string): boolean {
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath) || !existsSync(join(dir, "src", "main.ts")))
    return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return pkg.name === "@mycadet/credential-executor";
  } catch {
    return false;
  }
}

function findGatewaySourceFromCwd(): string | undefined {
  let current = process.cwd();
  while (true) {
    if (isGatewaySourceDir(current)) {
      return current;
    }
    const nestedCandidate = join(current, "gateway");
    if (isGatewaySourceDir(nestedCandidate)) {
      return nestedCandidate;
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function resolveAssistantIndexPath(entry?: LocalAssistant): string | undefined {
  if (entry) {
    const runtimeIndex = localRuntimeAssistantIndex(entry);
    if (runtimeIndex) return runtimeIndex;
  }

  // Reported source tree (the entrypoint's startup report or
  // CADET_SOURCE_ROOT): the same layout the spawning process already
  // resolved — bundled hosts have no module file position to walk from.
  const sourceRoot = getLocalSourceRoot();
  if (sourceRoot) {
    const sourceTreeIndex = join(sourceRoot, "assistant", "src", "index.ts");
    if (existsSync(sourceTreeIndex)) {
      return sourceTreeIndex;
    }

    // bunx layout: node_modules/mycadet nests the assistant's entry one level down.
    const bunxIndex = join(
      sourceRoot,
      "node_modules",
      "mycadet",
      "src",
      "index.ts",
    );
    if (existsSync(bunxIndex)) {
      return bunxIndex;
    }
  }

  const cwdSourceDir = findAssistantSourceFrom(process.cwd());
  if (cwdSourceDir) {
    return join(cwdSourceDir, "src", "index.ts");
  }

  const execSourceDir = findAssistantSourceFrom(dirname(process.execPath));
  if (execSourceDir) {
    return join(execSourceDir, "src", "index.ts");
  }

  try {
    const assistantPkgPath = _require.resolve(
      "@mycadet/assistant/package.json",
    );
    const resolved = join(dirname(assistantPkgPath), "src", "index.ts");
    if (existsSync(resolved)) {
      return resolved;
    }
  } catch {
    // resolution failed
  }

  return undefined;
}

function ensureBunInstalled(): void {
  try {
    execFileSync(resolveBunExecutable(), ["--version"], {
      stdio: "pipe",
      env: envWithBunPath(process.env),
      windowsHide: true,
    });
    return;
  } catch {
    // bun not found, try to install
  }

  console.log("   Installing bun...");
  try {
    const installEnv: Record<string, string> = {
      HOME: process.env.HOME || homedir(),
      PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      TMPDIR: process.env.TMPDIR || "/tmp",
      USER: process.env.USER || "",
      LANG: process.env.LANG || "",
    };
    // Preserve proxy/TLS env vars so curl works in proxied/corporate environments
    for (const key of [
      "HTTP_PROXY",
      "http_proxy",
      "HTTPS_PROXY",
      "https_proxy",
      "ALL_PROXY",
      "all_proxy",
      "NO_PROXY",
      "no_proxy",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
      "CURL_CA_BUNDLE",
    ]) {
      if (process.env[key]) {
        installEnv[key] = process.env[key]!;
      }
    }
    // Pinned. Keep in sync with .tool-versions.
    execSync('curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.11"', {
      stdio: "pipe",
      timeout: 60_000,
      env: installEnv,
      windowsHide: true,
    });
    console.log("   Bun installed successfully");
  } catch {
    console.log(
      "   ⚠️  Failed to install bun — some features may be unavailable",
    );
  }
}

function resolveDaemonMainPath(assistantIndex: string): string {
  return join(dirname(assistantIndex), "daemon", "main.ts");
}

/**
 * Generate a fresh random secret for local lifecycle use (e.g. the
 * guardian bootstrap secret). Not a signing key — the gateway owns the
 * signing key end-to-end; the CLI never touches it.
 */
type DaemonStartOptions = {
  requireReady?: boolean;
};

/**
 * Directory that holds the local CES Unix socket (`ces.sock`).
 *
 * A SIBLING of the CES data dir (`<instanceDir>/ces-data`), never a child of
 * it — matching the containerized layout, where the socket lives in its own
 * `/run/ces-ipc` mount and `ces-data` is a separate CES-private volume. The
 * data dir is CES-private state; the socket is the shared rendezvous.
 */
function resolveCesSocketDir(
  entry?: LocalAssistant,
  env?: Record<string, string | undefined>,
): string {
  if (entry) {
    return join(getLocalInstanceDir(entry), "ces-ipc");
  }
  return env?.CES_SOCKET_DIR?.trim() || join(resolveDataDir(), "ces-ipc");
}

/**
 * The cadet binaries a local assistant resolves from source, as shim
 * executables in the instance's own `bin/` dir: `assistant`, `gateway`,
 * `ces`. Everything else keeps the host PATH.
 */
const SHIMMED_COMMANDS = ["assistant", "gateway", "ces"] as const;

/**
 * Materialize the instance's XDG `bin/` folder: one executable shim per
 * cadet binary, each running that binary's source entry through bun — the
 * same resolution the daemon stack uses (`localSourceCommandEntry`), baked
 * at write time and refreshed by every assistant env build (hatch, wake,
 * exec) so an upgrade's new runtime install is picked up. The env builder
 * prepends the returned dir to PATH, which fixes compound commands, pipes,
 * and shell scripts that invoke the binaries — argv rewriting only ever
 * reached command[0]. A shim whose source cannot be resolved is simply not
 * written and reported in `unresolved`.
 */
export function ensureLocalBinShims(entry: LocalAssistant): {
  dir: string;
  unresolved: string[];
} {
  const dir = join(getLocalInstanceDir(entry), "bin");
  mkdirSync(dir, { recursive: true });
  const bunPath = resolveBunExecutable();
  const unresolved: string[] = [];
  for (const name of SHIMMED_COMMANDS) {
    const entryPath = localSourceCommandEntry(name, entry);
    if (!entryPath) {
      unresolved.push(name);
      continue;
    }
    const shim = join(dir, name);
    writeFileSync(
      shim,
      `#!/bin/sh\n# Generated by cadet — runs this binary from the local assistant's source.\nexec "${bunPath}" run "${entryPath}" "$@"\n`,
    );
    chmodSync(shim, 0o755);
  }
  return { dir, unresolved };
}

/**
 * The one shared instance env for daemon starts, wakes, hatches, and exec
 * legs: reads the caller's process.env, applies the instance's
 * workspace/security dirs, ports, and CES/IPC sockets, prepends the
 * instance's bin/ shims, and returns the spawn-ready copy. process.env is
 * left untouched — the returned env must be passed to the spawn explicitly.
 */
export function applyAssistantEnvironment(
  entry: LocalAssistant,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  env.RUNTIME_HTTP_PORT = env.RUNTIME_HTTP_PORT || "7821";
  env.CADET_CLOUD = "local";
  env.CADET_ENVIRONMENT = env.CADET_ENVIRONMENT || "local";
  env.CADET_WORKSPACE_DIR = join(getLocalInstanceDir(entry), "workspace");
  env.GATEWAY_SECURITY_DIR = join(
    getLocalInstanceDir(entry),
    "gateway-security",
  );
  env.CREDENTIAL_SECURITY_DIR = join(
    getLocalInstanceDir(entry),
    "ces-security",
  );
  env.CES_DATA_DIR = join(getLocalInstanceDir(entry), "ces-data");
  if (entry.daemonPort !== undefined) {
    env.RUNTIME_HTTP_PORT = String(entry.daemonPort);
  }
  if (entry.port !== undefined) env.GATEWAY_PORT = String(entry.port);
  delete env.QDRANT_URL;
  // CES and the assistant resolve the socket from CES_SOCKET_DIR.
  const socketDir = resolveCesSocketDir(entry, env);
  env.CES_SOCKET_DIR = socketDir;
  mkdirSync(socketDir, { recursive: true });
  applyIpcSocketDirOverride(env);
  // The instance's bin/ shims first on PATH: the cadet binaries then
  // resolve to the source build the daemons run (freshened on every call,
  // so an upgrade's new runtime is picked up). Best-effort — a shim that
  // cannot resolve just stays off the PATH.
  try {
    env.PATH = [ensureLocalBinShims(entry).dir, env.PATH]
      .filter(Boolean)
      .join(delimiter);
  } catch {
    // shim materialization never blocks env application
  }
  return env;
}

let startupLogging = true;

/**
 * Gates the chatty "Starting X... / ✅ X started" service lines. Hatch keeps
 * them silent unless the caller passed -v; other starters (wake, recover,
 * upgrade) leave the default on.
 */
export function setStartupLogging(enabled: boolean): void {
  startupLogging = enabled;
}

export function isStartupLoggingEnabled(): boolean {
  return startupLogging;
}

function startupLog(message = ""): void {
  if (startupLogging) console.log(message);
}

/**
 * Handle to a daemon this process spawned, reporting whether that child has
 * since exited. Attach paths have no handle, since the daemon they found is
 * not a child of this process.
 */
export type DaemonSpawn = { hasExited: () => boolean };

function trackDaemonSpawn(child: ChildProcess): DaemonSpawn {
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  return { hasExited: () => exited };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** How long a "starting" sentinel gets to resolve into a real PID before the
 * spawner that wrote it is judged dead and this caller takes over the start.
 * spawn() returns in milliseconds, so this is pure grace; the daemon's
 * migrations are the gateway's readiness wait, never this layer's. */
const STARTING_SENTINEL_SETTLE_MS = 15_000;
const STARTING_SENTINEL_POLL_MS = 250;

async function startDaemonFromSource(
  assistantIndex: string,
  entry: LocalAssistant,
  daemonPort: number,
  options?: DaemonStartOptions,
): Promise<DaemonSpawn | null> {
  const daemonMainPath = resolveDaemonMainPath(assistantIndex);

  // Ensure the directory containing PID/socket files exists. For named
  // instances this is instanceDir/.cadet/workspace/ (matching daemon's getWorkspaceDir()).
  const pidFile = getDaemonPidPath(entry);
  mkdirSync(dirname(pidFile), { recursive: true });

  // --- Lifecycle guard: prevent split-brain daemon state ---
  // The operator layer never health-checks the daemon's HTTP port: the port
  // is the daemon's own bind address (on its way to IPC-only), and the
  // cadet's health is the gateway's to answer. Liveness here is the PID file.
  if (await awaitStartingSentinel(pidFile)) {
    return null;
  }

  const existing = isProcessAlive(pidFile);
  if (existing.alive && existing.pid !== null) {
    console.log(`   Assistant already running (pid ${existing.pid})\n`);
    return null;
  }
  // Dead or stale PID — clean up so the fresh spawn owns the file.
  try {
    unlinkSync(pidFile);
  } catch {}

  const env = applyAssistantEnvironment(entry);

  // Write a sentinel PID file before spawning so concurrent hatch() calls
  // detect the in-progress spawn and wait instead of racing.
  writeFileSync(pidFile, "starting", "utf-8");

  const bunPath = resolveBunExecutable();
  const spawnEnv = envWithBunPath(env);
  const daemonLogFd = openRuntimeLogFile(
    getLocalInstanceDir(entry),
    "assistant",
  );
  const child = spawn(bunPath, ["run", resolve(daemonMainPath)], {
    cwd: spawnStateRoot(),
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: spawnEnv,
  });
  pipeToLogFile(child, daemonLogFd, "daemon");
  child.unref();

  if (!child.pid) {
    try {
      unlinkSync(pidFile);
    } catch {}
    return null;
  }
  writeFileSync(pidFile, String(child.pid), "utf-8");
  return trackDaemonSpawn(child);
}

// NOTE: startDaemonWatchFromSource() is the CLI-side watch-mode daemon
// launcher. Its lifecycle guards should eventually converge with
// assistant/src/daemon/daemon-control.ts::startDaemon which is the
// assistant-side equivalent.
async function startDaemonWatchFromSource(
  assistantIndex: string,
  entry: LocalAssistant,
  daemonPort: number,
  options?: DaemonStartOptions,
): Promise<DaemonSpawn | null> {
  const mainPath = resolveDaemonMainPath(assistantIndex);
  if (!existsSync(mainPath)) {
    throw new Error(`Daemon main.ts not found at ${mainPath}`);
  }

  const pidFile = getDaemonPidPath(entry);
  mkdirSync(dirname(pidFile), { recursive: true });

  // --- Lifecycle guard: prevent split-brain daemon state ---
  // The operator layer never health-checks the daemon's HTTP port: the port
  // is the daemon's own bind address (on its way to IPC-only), and the
  // cadet's health is the gateway's to answer. Liveness here is the PID file.
  if (await awaitStartingSentinel(pidFile)) {
    return null;
  }

  const existing = isProcessAlive(pidFile);
  if (existing.alive && existing.pid !== null) {
    console.log(`   Assistant already running (pid ${existing.pid})\n`);
    return null;
  }
  // Dead or stale PID — clean up so the fresh spawn owns the file.
  try {
    unlinkSync(pidFile);
  } catch {}

  const env = applyAssistantEnvironment(entry);

  // Write a sentinel PID file before spawning so concurrent hatch() calls
  // detect the in-progress spawn and wait instead of racing.
  writeFileSync(pidFile, "starting", "utf-8");

  const daemonLogFd = openRuntimeLogFile(
    getLocalInstanceDir(entry),
    "assistant",
  );
  const child = spawn(
    resolveBunExecutable(),
    ["--watch", "run", resolve(mainPath)],
    {
      cwd: spawnStateRoot(),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: envWithBunPath(env),
    },
  );
  pipeToLogFile(child, daemonLogFd, "daemon");
  child.unref();
  const daemonPid = child.pid;

  // Overwrite sentinel with real PID, or clean up on spawn failure.
  if (!daemonPid) {
    try {
      unlinkSync(pidFile);
    } catch {}
    return null;
  }
  writeFileSync(pidFile, String(daemonPid), "utf-8");

  console.log("   Assistant started in watch mode with bun --watch");
  return trackDaemonSpawn(child);
}

function resolveGatewayDir(entry?: LocalAssistant): string {
  const runtimeGatewayDir = localRuntimeGatewayDir(entry);
  if (runtimeGatewayDir) return runtimeGatewayDir;

  // Reported source tree: the gateway checkout the launching process
  // resolved, plus the npm sibling of a bunx/npm-installed CLI.
  const sourceRoot = getLocalSourceRoot();
  if (sourceRoot) {
    const sourceDir = join(sourceRoot, "gateway");
    if (isGatewaySourceDir(sourceDir)) {
      return sourceDir;
    }

    const npmGatewayDir = join(
      sourceRoot,
      "node_modules",
      "@mycadet",
      "gateway",
    );
    if (isGatewaySourceDir(npmGatewayDir)) {
      return npmGatewayDir;
    }
  }

  // Compiled binary: gateway/ bundled adjacent to the CLI executable.
  const binGateway = join(dirname(process.execPath), "gateway");
  if (isGatewaySourceDir(binGateway)) {
    return binGateway;
  }

  const cwdSourceDir = findGatewaySourceFromCwd();
  if (cwdSourceDir) {
    return cwdSourceDir;
  }

  try {
    const pkgPath = _require.resolve("@mycadet/gateway/package.json");
    return dirname(pkgPath);
  } catch {
    throw new Error(
      "Gateway not found. Ensure @mycadet/gateway is installed or run from the source tree.",
    );
  }
}

/**
 * The source entry point a cadet command name runs, matching each package's
 * own bin: assistant -> `src/index.ts`, gateway -> `src/cli/index.ts` (the
 * CLI, not the server entry startGateway spawns), ces -> `src/cli.ts`. Only
 * the three user-facing binaries resolve — `credential-executor` stays
 * unexposed (the `ces` spelling is the binary this repo publishes for
 * humans). Undefined when the name is not one of the three or its source
 * cannot be resolved — callers decide what fallback (host PATH) means. The
 * same resolution the daemon stack uses in `startLocalDaemon` /
 * `startGateway` / `startCes`, so a command exec'd against a local
 * assistant runs the build the daemons run.
 */
export function localSourceCommandEntry(
  name: string,
  entry?: LocalAssistant,
): string | undefined {
  switch (name) {
    case "assistant":
      return resolveAssistantIndexPath(entry);
    case "gateway":
      try {
        return join(resolveGatewayDir(entry), "src/cli/index.ts");
      } catch {
        return undefined;
      }
    case "ces":
      try {
        return join(resolveCesDir(entry), "src/cli.ts");
      } catch {
        return undefined;
      }
    default:
      return undefined;
  }
}

/**
 * Resolve the credential-executor source dir, or undefined when neither a
 * self-managed runtime install, the reported source tree, nor node_modules
 * has one.
 */
export function findCesDir(entry?: LocalAssistant): string | undefined {
  const runtimeCesDir = localRuntimeCesDir(entry);
  if (runtimeCesDir) return runtimeCesDir;

  // Reported source tree / npm sibling: walk up from the reported root
  // until a `credential-executor/` sibling appears.
  const sourceRoot = getLocalSourceRoot();
  if (sourceRoot) {
    const fromRoot = findCesSourceFrom(sourceRoot);
    if (fromRoot) return fromRoot;
  }

  // Bundled hosts report garbage (or nothing) for their own position —
  // find the sources from the anchors a spawned process still has: the
  // cwd it was launched from, and the binary's dir.
  const fromCwd = findCesSourceFrom(process.cwd());
  if (fromCwd) return fromCwd;

  const fromExec = findCesSourceFrom(dirname(process.execPath));
  if (fromExec) return fromExec;

  // npm-installed elsewhere on disk: resolve via the package entry.
  try {
    const pkgPath = _require.resolve(
      "@mycadet/credential-executor/package.json",
    );
    return dirname(pkgPath);
  } catch {
    return undefined;
  }
}

function resolveCesDir(entry?: LocalAssistant): string {
  const cesDir = findCesDir(entry);
  if (!cesDir) {
    throw new Error(
      "credential-executor not found. Ensure @mycadet/credential-executor is installed or run from the source tree.",
    );
  }
  return cesDir;
}

/**
 * Resolve the local IPC endpoint shared by the CLI-launched CES sibling and
 * assistant. CES binds this path from `CES_SOCKET_DIR` via the same
 * `resolveIpcEndpoint("ces")` helper. Windows uses a named pipe. POSIX uses
 * a Unix socket, including the shared macOS AF_UNIX fallback.
 */
export function resolveCesSocketPath(
  entry?: LocalAssistant,
  hostPlatform: NodeJS.Platform = platform(),
): string {
  return resolveIpcEndpoint("ces", {
    workspaceDir: resolveCesSocketDir(entry),
    platform: hostPlatform,
  }).path;
}

/**
 * Launch the local CES sibling over a local IPC endpoint. This is the default
 * topology for local instances and matches the containerized CES layout.
 *
 * The sibling runs as an independent process with its lifecycle anchored to
 * SIGTERM, mirroring the gateway: a CLI-owned process with a PID file under
 * `.cadet/ces.pid`, started by `wake` and stopped by `sleep`.
 */
export async function startCes(
  watch: boolean = false,
  entry: LocalAssistant,
): Promise<void> {
  const cadetDir = getLocalInstanceDir(entry);
  const cesPidFile = join(cadetDir, "ces.pid");

  // Kill any existing sibling first — a stale CES holds the socket and would
  // corrupt the shared credential store if a second copy also bound it.
  await stopProcessByPidFile(cesPidFile, "credential-executor");

  startupLog("🔐 Starting credential-executor sibling...");

  const socketPath = resolveCesSocketPath(entry);
  // A stale socket file from an unclean shutdown blocks re-bind; CES unlinks it
  // on startup, but remove it here too so a leftover never masks a launch bug.
  removeIpcEndpointFile(socketPath);

  const securityDir = entry
    ? join(getLocalInstanceDir(entry), "ces-security")
    : join(resolveDataDir(), "ces-security");
  const dataDir = entry
    ? join(getLocalInstanceDir(entry), "ces-data")
    : join(resolveDataDir(), "ces-data");
  const workspaceDir = entry
    ? join(getLocalInstanceDir(entry), "workspace")
    : join(resolveDataDir(), "workspace");
  const socketDir = resolveCesSocketDir(entry);
  mkdirSync(securityDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(socketDir, { recursive: true });

  const cesHealthPort = await findAvailablePort(getDefaultPorts().ces);

  const cesEnv: Record<string, string | undefined> = {
    ...process.env,
    CREDENTIAL_SECURITY_DIR: securityDir,
    CES_DATA_DIR: dataDir,
    CADET_WORKSPACE_DIR: workspaceDir,
    CES_SOCKET_DIR: socketDir,
    CES_HEALTH_PORT: String(cesHealthPort),
  };

  // credential-executor always runs from source through bun: the packaged
  // runtime ships its source beside the bundled bun, and dev/bunx installs
  // resolve it from the source tree or node_modules.
  const cesDir = localRuntimeCesDir(entry) ?? resolveCesDir(entry);
  const cesEntry = join(cesDir, "src/main.ts");
  const bunArgs = watch ? ["--watch", "run", cesEntry] : ["run", cesEntry];
  const cesLogFd = openLogFile("hatch.log");
  const ces = spawn(resolveBunExecutable(), bunArgs, {
    cwd: spawnStateRoot(),
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: envWithBunPath(cesEnv),
  });
  pipeToLogFile(ces, cesLogFd, "credential-executor");
  if (watch) {
    startupLog("   credential-executor started in watch mode (bun --watch)");
  }

  ces.unref();

  if (ces.pid) {
    mkdirSync(cadetDir, { recursive: true });
    writeFileSync(cesPidFile, String(ces.pid), "utf-8");
  }

  startupLog("✅ credential-executor started\n");
}

/**
 * Find the PID of the process listening on the given TCP port.
 * Uses `lsof` on macOS/Linux. Returns undefined if no listener is found
 * or the command fails.
 */
export function findPidListeningOnPort(port: number): number | undefined {
  try {
    const output = execFileSync(
      "lsof",
      ["-iTCP:" + port, "-sTCP:LISTEN", "-t"],
      {
        encoding: "utf-8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      },
    ).trim();
    // lsof -t may return multiple PIDs (one per line); take the first.
    const pid = parseInt(output.split("\n")[0], 10);
    return isNaN(pid) ? undefined : pid;
  } catch {
    return undefined;
  }
}

/**
 * Handle the "starting" sentinel in a PID file. When another caller is
 * already spawning the daemon, wait for its spawn to settle instead of
 * racing to a duplicate. The CLI never probes the daemon's HTTP port, so
 * there is no readiness to wait out here — only the handoff: the sentinel
 * resolving into a real PID means the concurrent spawner won; a sentinel
 * that never resolves was written by a dead spawner, and this caller
 * cleans it up and proceeds.
 *
 * Returns `true` if a concurrent spawner owns the start (caller should
 * return early), `false` if this caller should proceed.
 */
export async function awaitStartingSentinel(pidFile: string): Promise<boolean> {
  if (!existsSync(pidFile)) return false;
  try {
    const content = readFileSync(pidFile, "utf-8").trim();
    if (content !== "starting") return false;
  } catch {
    return false;
  }

  console.log("   Assistant is starting — waiting for the spawn to settle...");
  const deadline = Date.now() + STARTING_SENTINEL_SETTLE_MS;
  while (Date.now() < deadline) {
    await sleep(STARTING_SENTINEL_POLL_MS);
    if (!existsSync(pidFile)) return false;
    try {
      if (readFileSync(pidFile, "utf-8").trim() !== "starting") return true;
    } catch {
      return false;
    }
  }
  try {
    unlinkSync(pidFile);
  } catch {}
  return false;
}

export async function discoverPublicUrl(
  port?: number,
): Promise<string | undefined> {
  const effectivePort = port ?? GATEWAY_PORT;

  // Start cloud metadata lookup (may take up to 1s on non-cloud hosts).
  const cloudIpPromise = discoverCloudExternalIp();

  // Resolve local address synchronously (no I/O) — does not log.
  const localResult = discoverLocalUrl(effectivePort);

  // Race: if cloud IP resolves quickly, prefer it; otherwise return the
  // local URL immediately instead of blocking on the full metadata timeout.
  const cloudIp = await Promise.race([
    cloudIpPromise,
    // Give cloud metadata a short grace period (150ms) before falling back
    // to the local address. This is enough for on-cloud hosts where the
    // metadata endpoint responds in single-digit ms, but avoids the full
    // 1s timeout on non-cloud machines.
    new Promise<undefined>((resolve) =>
      setTimeout(() => resolve(undefined), 150),
    ),
  ]);

  if (cloudIp) {
    console.log(`   Discovered external IP: ${cloudIp}`);
    return `http://${cloudIp}:${effectivePort}`;
  }

  return localResult.url;
}

/**
 * Returns the localhost URL for the gateway on the given port.
 */
function discoverLocalUrl(effectivePort: number): {
  url: string;
  source: "localhost";
} {
  return {
    url: `http://127.0.0.1:${effectivePort}`,
    source: "localhost",
  };
}

/**
 * Attempt to discover the VM's external/public IP via cloud metadata services.
 * Tries GCP and AWS IMDSv2 in parallel with a short timeout. Returns undefined
 * on non-cloud machines (the metadata endpoint is unreachable).
 */
async function discoverCloudExternalIp(): Promise<string | undefined> {
  const timeoutMs = 1000;

  const gcpPromise = (async (): Promise<string | undefined> => {
    try {
      const resp = await fetch(
        "http://169.254.169.254/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip",
        {
          headers: { "Metadata-Flavor": "Google" },
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
      if (resp.ok) return (await resp.text()).trim() || undefined;
    } catch {
      // metadata service not reachable
    }
    return undefined;
  })();

  const awsPromise = (async (): Promise<string | undefined> => {
    try {
      const tokenResp = await fetch("http://169.254.169.254/latest/api/token", {
        method: "PUT",
        headers: { "X-aws-ec2-metadata-token-ttl-seconds": "30" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (tokenResp.ok) {
        const token = await tokenResp.text();
        const ipResp = await fetch(
          "http://169.254.169.254/latest/meta-data/public-ipv4",
          {
            headers: { "X-aws-ec2-metadata-token": token },
            signal: AbortSignal.timeout(timeoutMs),
          },
        );
        if (ipResp.ok) return (await ipResp.text()).trim() || undefined;
      }
    } catch {
      // metadata service not reachable
    }
    return undefined;
  })();

  const [gcpIp, awsIp] = await Promise.all([gcpPromise, awsPromise]);
  return gcpIp ?? awsIp;
}

/**
 * Check whether watch-mode startup is possible for the gateway. Watch mode
 * requires gateway source files (bun --watch only works with .ts sources).
 * Returns true when the gateway source directory can be resolved, false
 * otherwise.
 *
 * Use this before stopping a running gateway for a watch-mode restart — if
 * watch mode isn't available, the caller should keep the existing process
 * alive rather than killing it and failing.
 */
export function isGatewayWatchModeAvailable(): boolean {
  try {
    const dir = resolveGatewayDir();
    return existsSync(join(dir, "src", "index.ts"));
  } catch {
    return false;
  }
}

// NOTE: startLocalDaemon() is the CLI-side daemon lifecycle manager.
// It should eventually converge with
// assistant/src/daemon/daemon-control.ts::startDaemon which is the
// assistant-side equivalent.
export async function startLocalDaemon(
  watch: boolean = false,
  entry: LocalAssistant,
  options?: DaemonStartOptions,
): Promise<void> {
  const daemonPort =
    entry.daemonPort ?? Number(process.env.RUNTIME_HTTP_PORT || "7821");

  // The assistant daemon always runs from source through bun: the packaged
  // runtime ships assistant source beside the bundled bun, and dev/bunx
  // installs resolve it from the source tree or node_modules.
  const assistantIndex =
    localRuntimeAssistantIndex(entry) ?? resolveAssistantIndexPath(entry);
  if (!assistantIndex) {
    throw new Error(
      "Assistant source not found.\n" +
        "  Ensure the runtime ships assistant source, or run from the source tree.",
    );
  }
  startupLog("🔨 Starting local assistant...");
  const sourceSpawn = watch
    ? await startDaemonWatchFromSource(
        assistantIndex,
        entry,
        daemonPort,
        options,
      )
    : await startDaemonFromSource(assistantIndex, entry, daemonPort, options);
  void sourceSpawn;
  // Spawn and return — readiness is the gateway's responsibility: its
  // process gates its own traffic on the daemon's migrations.
}

export async function startGateway(
  watch: boolean = false,
  entry: LocalAssistant,
  options?: {
    requireReady?: boolean;
  },
): Promise<string> {
  const effectiveGatewayPort = entry?.port ?? GATEWAY_PORT;

  // Kill any existing gateway process before spawning a new one.
  // Without this, crashed/stale gateways accumulate as zombies — the old
  // process holds the port (or lingers after losing it), and every restart
  // attempt spawns yet another process that fails with EADDRINUSE.
  await stopProcessByPidFile(getGatewayPidPath(entry), "gateway");

  const publicUrl = await discoverPublicUrl(effectiveGatewayPort);

  startupLog("🌐 Starting gateway...");

  const effectiveDaemonPort =
    entry?.daemonPort ?? Number(process.env.RUNTIME_HTTP_PORT || "7821");

  const gatewayEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    RUNTIME_HTTP_PORT: String(effectiveDaemonPort),
    GATEWAY_PORT: String(effectiveGatewayPort),
    // Pass gateway operational settings via env vars so the CLI does not
    // need direct access to the workspace config file.
    RUNTIME_PROXY_REQUIRE_AUTH: "true",
    ...(watch
      ? {
          CADET_ENVIRONMENT: process.env.CADET_ENVIRONMENT || "local",
        }
      : {}),
    // Pin gateway workspace/security paths to the named instance so parent
    // env vars cannot leak a different workspace. The gateway opens the
    // assistant DB directly for guardian bootstrap.
    ...(entry
      ? {
          CADET_WORKSPACE_DIR: join(getLocalInstanceDir(entry), "workspace"),
          GATEWAY_SECURITY_DIR: join(
            getLocalInstanceDir(entry),
            "gateway-security",
          ),
          CREDENTIAL_SECURITY_DIR: join(
            getLocalInstanceDir(entry),
            "ces-security",
          ),
          CES_DATA_DIR: join(getLocalInstanceDir(entry), "ces-data"),
        }
      : {}),
  };

  applyIpcSocketDirOverride(gatewayEnv);

  // The gateway always runs from source through bun: the packaged runtime
  // ships gateway source beside the bundled bun, and dev/bunx installs
  // resolve it from the source tree or node_modules.
  const gatewayDir = localRuntimeGatewayDir(entry) ?? resolveGatewayDir(entry);
  const gatewayEntry = join(gatewayDir, "src/index.ts");
  const bunArgs = watch
    ? ["--watch", "run", gatewayEntry, "--cadet-gateway"]
    : ["run", gatewayEntry, "--cadet-gateway"];
  const gwLogFd = openRuntimeLogFile(getLocalInstanceDir(entry), "gateway");
  const gateway = spawn(resolveBunExecutable(), bunArgs, {
    cwd: spawnStateRoot(),
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: envWithBunPath(gatewayEnv),
  });
  pipeToLogFile(gateway, gwLogFd, "gateway");
  if (watch) {
    startupLog("   Gateway started in watch mode (bun --watch)");
  }

  gateway.unref();

  if (gateway.pid) {
    writeFileSync(getGatewayPidPath(entry), String(gateway.pid), "utf-8");
  }

  const gatewayUrl = publicUrl || `http://localhost:${effectiveGatewayPort}`;

  // Wait for the gateway to be responsive before returning. Without this,
  // callers may try to connect before the HTTP server is listening and get
  // connection-refused errors.
  const ready = await waitForDaemonReady(effectiveGatewayPort, 30000);
  if (!ready) {
    if (options?.requireReady) {
      throw new Error(
        "Assistant gateway did not bind its local port within 30 seconds.",
      );
    }
    console.warn(
      "⚠ Gateway started but health check did not respond within 30s",
    );
  }

  startupLog("✅ Gateway started\n");
  return gatewayUrl;
}
