import { execOutput } from "../step-runner.js";
import {
  type ChildProcess,
  execFileSync,
  execSync,
  spawn,
  spawnSync,
} from "child_process";
import { createHash, randomBytes } from "crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { createRequire } from "module";
import { Socket } from "net";
import { homedir, platform, tmpdir } from "os";
import { basename, dirname, isAbsolute, join, resolve } from "path";

import {
  findAssistantCommand,
  isRepoCheckoutPath,
} from "@mycadet/environments";
import {
  isNamedPipePath,
  removeIpcEndpointFile,
  resolveIpcEndpoint,
} from "@mycadet/ipc-server-utils";
import { isValidReleaseVersion } from "@mycadet/local-mode";

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

import {
  allocateLocalPlacement,
  findAssistantByName,
  findAvailablePort,
  setActiveAssistant,
} from "../assistant-config.js";
import type { LockfileAssistant } from "@mycadet/local-mode/contract";
import type {
  LocalAssistant,
  DockerAssistant,
  AppleContainerAssistant,
} from "@mycadet/local-mode/contract";
import { GATEWAY_PORT } from "../constants.js";
import {
  resolveDataDir,
  resolveLogDir,
  saveLockfileAssistant,
} from "@mycadet/local-mode";
import { getGatewayUrl, isLocalEntry } from "@mycadet/local-mode/contract";
import {
  type DaemonReadiness,
  httpHealthCheck,
  probeDaemonReadiness,
  probeDaemonReadinessWithRetry,
  waitForDaemonMigrationsReady,
  waitForDaemonReady,
} from "../http-client.js";
import {
  DAEMON_STOP_TIMEOUT_MS,
  type ProcessState,
  executableName,
  isProcessAlive,
  pathListDelimiter,
  resolveProcessState,
  stopProcessByPidFile,
  stopProcessGracefully,
} from "../process.js";
import { stripVersionPrefix } from "../version-compat.js";
import { openLogFile, openRuntimeLogFile, pipeToLogFile } from "../xdg-log.js";
import { green, yellow } from "../color.js";
import { buildHatchConfigValues, writeInitialConfig } from "../config-utils.js";
import {
  GuardianLeasePermanentError,
  leaseGuardianToken,
  loadGuardianBootstrapSecret,
  saveGuardianBootstrapSecret,
} from "../guardian-token.js";
import {
  consoleLifecycleReporter,
  type LifecycleReporter,
} from "../lifecycle-reporter.js";
import {
  collectProviderApiKey,
  configureHatchProviderApiKey,
  promptProviderChoice,
  resolveHatchProvider,
  shouldPromptForHatchProvider,
} from "../provider-secrets.js";
import { logHatchNextSteps } from "../hatch-next-steps.js";
import { printInstanceDetails } from "../instance-details.js";
import { checkProviderApiKey } from "../api-key-check.js";
import {
  describeLoginError,
  ensureCloudLoginInteractive,
  registerLocalAssistantWithCloud,
} from "../cloud-login.js";
import { fetchCurrentUser, readCloudToken } from "../cloud-client.js";
import { withLocalHatchLock } from "../local-hatch-lock.js";
import { generateInstanceName } from "../random-name.js";
import { healConflictedLocalPorts } from "../port-heal.js";
import { restoreAppServerAndAutoTunnel } from "../tunnel.js";

// Direct import — bun embeds this at compile time so it works in compiled binaries.
import cliPkg from "../../../package.json";
import { getDefaultPorts } from "../environments/paths.js";

const _require = createRequire(import.meta.url);

// macOS AF_UNIX path limit (sun_path is 104 bytes, null-terminated → 103 usable).
const DARWIN_UNIX_SOCKET_MAX_PATH_BYTES = 103;

// The longest socket filename we place in the workspace directory.
// assistant.sock = 14 chars, plus 1 for the "/" separator = 15 overhead.
const LONGEST_SOCKET_FILENAME = "assistant.sock";
const LOCAL_RUNTIME_PACKAGE = "cadet";
const PATH_DELIMITER = pathListDelimiter(platform());
const DEFAULT_EXECUTABLE_PATH =
  platform() === "win32"
    ? "C:\\Windows\\System32;C:\\Windows"
    : "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

export interface LocalRuntimeInstall {
  version: string;
  installDir: string;
}

function normalizeRuntimeVersion(version: string): string {
  return version === "latest" ? version : stripVersionPrefix(version);
}

export function getLocalRuntimeInstallDir(
  entry: LocalAssistant | DockerAssistant | AppleContainerAssistant,
  version: string,
): string {
  return join(
    getLocalInstanceDir(entry),
    "runtime",
    normalizeRuntimeVersion(version),
  );
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

/**
 * True when this process is a compiled standalone binary (desktop app or
 * `bun build --compile` CLI) rather than a script executed by a plain `bun`
 * binary (source tree, bunx, npm/global install).
 *
 * Only a compiled binary may trust product siblings in
 * `dirname(process.execPath)`: under plain bun that directory is bun's own
 * bin dir (e.g. `~/.bun/bin`), where bin links of globally-installed packages
 * (`assistant`, `credential-executor`) collide with app-bundle binary names
 * and point at whatever version happens to be installed globally.
 */
export function isCompiledCli(): boolean {
  const execBase = basename(process.execPath).replace(/\.exe$/i, "");
  return (
    execBase !== "bun" && execBase !== "bunx" && !execBase.startsWith("bun-")
  );
}

function compiledSibling(name: string): string {
  return join(dirname(process.execPath), executableName(name, platform()));
}

function envWithCompiledRuntimeNodePath(
  env: Record<string, string>,
): Record<string, string> {
  if (!isCompiledCli()) {
    return env;
  }
  return {
    ...env,
    NODE_PATH: join(dirname(process.execPath), "node_modules"),
  };
}

function resolveBunExecutable(): string {
  if (!isCompiledCli()) {
    return process.execPath;
  }

  const envBun = process.env.CADET_BUN;
  if (envBun && existsSync(envBun)) return envBun;

  const bunName = executableName("bun", platform());
  const siblingBun = compiledSibling("bun");
  if (existsSync(siblingBun)) return siblingBun;

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
  commandDirs: string[] = [],
): Record<string, string | undefined> {
  const bunPath = resolveBunExecutable();
  const basePath = env.PATH || DEFAULT_EXECUTABLE_PATH;
  const extraDirs = [
    isAbsolute(bunPath) ? dirname(bunPath) : "",
    ...commandDirs,
    join(homedir(), ".bun", "bin"),
    join(homedir(), ".local", "bin"),
  ].filter((dir) => dir && !basePath.split(PATH_DELIMITER).includes(dir));
  return {
    ...env,
    PATH: [...extraDirs, basePath].filter(Boolean).join(PATH_DELIMITER),
  };
}

function localRuntimeAssistantIndex(
  entry: LocalAssistant | DockerAssistant | AppleContainerAssistant,
): string | undefined {
  const installDir = entry.runtimeInstallDir;
  if (!installDir) return undefined;
  const candidate = packagePath(
    installDir,
    "@mycadet/assistant",
    "src/index.ts",
  );
  return existsSync(candidate) ? candidate : undefined;
}

function localRuntimeGatewayDir(
  entry: LocalAssistant | DockerAssistant | AppleContainerAssistant | undefined,
): string | undefined {
  const installDir = entry?.runtimeInstallDir;
  if (!installDir) return undefined;
  const candidate = packagePath(installDir, "@mycadet/gateway", "");
  return isGatewaySourceDir(candidate) ? candidate : undefined;
}

function localRuntimeCesDir(
  entry: LocalAssistant | DockerAssistant | AppleContainerAssistant | undefined,
): string | undefined {
  const installDir = entry?.runtimeInstallDir;
  if (!installDir) return undefined;
  const candidate = packagePath(installDir, "@mycadet/credential-executor", "");
  return isCesSourceDir(candidate) ? candidate : undefined;
}

export function ensureLocalRuntime(
  entry: LocalAssistant | DockerAssistant | AppleContainerAssistant,
  version: string,
  options: { force?: boolean } = {},
): LocalRuntimeInstall {
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
  const installDir = getLocalRuntimeInstallDir(entry, normalizedVersion);

  if (!options.force && hasLocalRuntimeComponents(installDir)) {
    return { version: displayVersion, installDir };
  }

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
  const result = spawnSync(bunPath, ["install", "--ignore-scripts"], {
    cwd: installDir,
    stdio: "inherit",
    env: envWithBunPath(process.env),
    windowsHide: true,
  });

  if (result.error || result.status !== 0) {
    const detail =
      result.error?.message ?? `bun install exited with code ${result.status}`;
    throw new Error(`Local runtime install failed: ${detail}`);
  }

  if (!hasLocalRuntimeComponents(installDir)) {
    throw new Error(
      `Local runtime install at ${installDir} is missing assistant, gateway, or credential-executor packages.`,
    );
  }

  return { version: displayVersion, installDir };
}

/**
 * On macOS, if `{workspaceDir}/assistant.sock` would exceed the
 * 103-byte AF_UNIX path limit, compute a short tmpdir-based IPC socket
 * directory and return it.  Returns `undefined` when no override is needed
 * (the workspace path is short enough, or we're not on macOS).
 */
function computeIpcSocketDirOverride(workspaceDir: string): string | undefined {
  if (platform() !== "darwin") return undefined;

  const longestPath = join(workspaceDir, LONGEST_SOCKET_FILENAME);
  if (
    Buffer.byteLength(longestPath, "utf8") <= DARWIN_UNIX_SOCKET_MAX_PATH_BYTES
  ) {
    return undefined;
  }

  // Use a short hash of the workspace dir so multiple instances get
  // distinct socket directories under /tmp.
  const hash = createHash("sha256")
    .update(workspaceDir)
    .digest("hex")
    .slice(0, 12);
  return join(tmpdir(), `cadet-ipc-${hash}`);
}

/**
 * If the workspace path is too long for AF_UNIX sockets on macOS, compute
 * a short override directory and set all IPC socket env vars on the target
 * env object. No-op on non-macOS or when paths are within limits.
 */
function applyIpcSocketDirOverride(
  env: Record<string, string | undefined>,
): void {
  const workspaceDir =
    env.CADET_WORKSPACE_DIR || join(resolveDataDir(), "workspace");
  const override = computeIpcSocketDirOverride(workspaceDir);
  if (!override) return;

  mkdirSync(override, { recursive: true });
  env.GATEWAY_IPC_SOCKET_DIR = override;
  env.ASSISTANT_IPC_SOCKET_DIR = override;
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

function resolveAssistantIndexPath(
  entry?: LocalAssistant | DockerAssistant | AppleContainerAssistant,
): string | undefined {
  if (entry) {
    const runtimeIndex = localRuntimeAssistantIndex(entry);
    if (runtimeIndex) return runtimeIndex;
  }

  // Source tree layout: cli/src/lib/ -> ../../.. -> repo root -> assistant/src/index.ts
  const sourceTreeIndex = join(
    import.meta.dir,
    "..",
    "..",
    "..",
    "assistant",
    "src",
    "index.ts",
  );
  if (existsSync(sourceTreeIndex)) {
    return sourceTreeIndex;
  }

  // bunx layout: @mycadet/cli/src/lib/ -> ../../../.. -> node_modules/cadet/src/index.ts
  const bunxIndex = join(
    import.meta.dir,
    "..",
    "..",
    "..",
    "..",
    "cadet",
    "src",
    "index.ts",
  );
  if (existsSync(bunxIndex)) {
    return bunxIndex;
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
export function generateLocalSecret(): string {
  return randomBytes(32).toString("hex");
}

type DaemonStartOptions = {
  foreground?: boolean;
  defaultWorkspaceConfigPath?: string;
  requireReady?: boolean;
};

/**
 * Directory that holds the local CES Unix socket (`ces.sock`).
 *
 * Matches CES's local data root: `{CES_DATA_DIR}` (`<instanceDir>/ces-data`).
 * Local CLI and managed sidecars share `CES_BOOTSTRAP_SOCKET_DIR`; this is the
 * writable per-instance directory used outside containers.
 */
function resolveCesBootstrapSocketDir(
  entry?: LocalAssistant | DockerAssistant | AppleContainerAssistant,
  env?: Record<string, string | undefined>,
): string {
  if (entry) {
    return join(getLocalInstanceDir(entry), "ces-data");
  }
  const dataDir =
    env?.CES_DATA_DIR?.trim() || join(resolveDataDir(), "ces-data");
  return dataDir;
}

/**
 * Apply per-instance resource overrides and shared daemon options to an
 * environment object. Called from all daemon spawn paths (source, watch,
 * bundled binary) to eliminate drift between the three.
 */
function applyDaemonEnvOverrides(
  env: Record<string, string | undefined>,
  entry: LocalAssistant | DockerAssistant | AppleContainerAssistant,
  options?: DaemonStartOptions,
): void {
  {
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
    if (entry.daemonPort !== undefined)
      env.RUNTIME_HTTP_PORT = String(entry.daemonPort);
    if (entry.port !== undefined) env.GATEWAY_PORT = String(entry.port);
    delete env.QDRANT_URL;
  }
  if (options?.defaultWorkspaceConfigPath) {
    env.CADET_DEFAULT_WORKSPACE_CONFIG_PATH =
      options.defaultWorkspaceConfigPath;
  }
  // CES and the assistant resolve the socket from CES_BOOTSTRAP_SOCKET_DIR.
  const bootstrapDir = resolveCesBootstrapSocketDir(entry, env);
  env.CES_BOOTSTRAP_SOCKET_DIR = bootstrapDir;
  mkdirSync(bootstrapDir, { recursive: true });
  applyIpcSocketDirOverride(env);
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

function startupLog(message = ""): void {
  if (startupLogging) console.log(message);
}

function logDaemonReadiness(
  readiness: DaemonReadiness,
  requireReady = false,
): void {
  switch (readiness) {
    case "ready":
      startupLog("   Assistant ready\n");
      break;
    case "migrating":
      console.log(
        "   Assistant is up. Database migrations still running; DB-backed commands return 503 until they finish\n",
      );
      break;
    case "failed":
      console.log(
        "   ⚠️  Assistant database migrations FAILED. DB-backed commands return 503 until the assistant is restarted\n",
      );
      break;
    default:
      if (requireReady) {
        throw new Error(
          "Assistant did not bind its local port within 60 seconds.",
        );
      }
      console.log(
        "   ⚠️  Assistant did not become ready within 60s, continuing anyway\n",
      );
  }
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

/** How long a fresh spawn gets to abort before its readiness is trusted. */
const FRESH_SPAWN_SETTLE_MS = 2000;
const FRESH_SPAWN_POLL_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * True when a freshly spawned daemon is the process serving its runtime HTTP
 * port.
 *
 * A readiness answer proves only that something listens on the port: a foreign
 * listener holding it answers in the daemon's place, so a daemon aborting over
 * the collision still reads as "up" or "migrating". Ownership is confirmed
 * from the listening PID where the cloud can report it. Otherwise the spawn
 * gets a short settle window, which is long enough because transports bind
 * before migrations run, so an address collision aborts the daemon early.
 */
async function freshSpawnServesRuntimePort(
  spawn: DaemonSpawn,
  pidFile: string,
  daemonPort: number,
): Promise<boolean> {
  const spawnPid = (): number | null => {
    if (spawn.hasExited()) {
      return null;
    }
    return isProcessAlive(pidFile).pid;
  };

  const pid = spawnPid();
  if (pid === null) {
    return false;
  }
  if (findPidListeningOnPort(daemonPort) === pid) {
    return true;
  }

  const deadline = Date.now() + FRESH_SPAWN_SETTLE_MS;
  while (Date.now() < deadline) {
    await sleep(FRESH_SPAWN_POLL_MS);
    if (spawnPid() === null) {
      return false;
    }
  }
  return true;
}

/**
 * Report a freshly spawned daemon's readiness, gated on that daemon serving
 * the runtime HTTP port the readiness was probed on.
 *
 * A daemon that aborts during startup (an occupied runtime HTTP port, a fatal
 * subsystem failure) is reported as the startup failure it is instead of an
 * optimistic line about an assistant that is not running.
 */
export async function reportFreshSpawnReadiness(
  spawn: DaemonSpawn,
  pidFile: string,
  daemonPort: number,
  readiness: DaemonReadiness,
  requireReady = false,
): Promise<void> {
  if (!(await freshSpawnServesRuntimePort(spawn, pidFile, daemonPort))) {
    if (requireReady) {
      throw new Error("Assistant exited during startup and is not running.");
    }
    console.log("   ⚠️  Assistant exited during startup and is not running\n");
    return;
  }
  logDaemonReadiness(readiness, requireReady);
}

/**
 * The instance's data root: the recorded instanceDir, or the shared state
 * root for legacy entries predating per-instance dirs.
 */
export function getLocalInstanceDir(
  entry?: LockfileAssistant | undefined,
): string {
  return (
    (entry &&
    (entry.cloud === "local" ||
      entry.cloud === "docker" ||
      entry.cloud === "apple-container")
      ? entry.instanceDir
      : undefined) ?? resolveDataDir()
  );
}

/**
 * Derive the daemon PID file path from an entry. The PID file lives inside
 * the instance's workspace directory. Falls back to the XDG data root's
 * workspace when the entry carries no instance dir.
 */
export function getDaemonPidPath(
  entry?: LockfileAssistant | undefined,
): string {
  return join(getLocalInstanceDir(entry), "workspace", "cadet.pid");
}

function logAssistantAlreadyRunning(
  pid: number,
  status: ProcessState["status"],
): void {
  const suffix =
    status === "migration_failed"
      ? " but its database migrations failed — restart to recover"
      : status === "unready"
        ? " — database migrations still running"
        : status === "stuck"
          ? " but is not responding and could not be stopped"
          : "";
  console.log(`   Assistant already running (pid ${pid})${suffix}\n`);
}

async function startDaemonFromSource(
  assistantIndex: string,
  entry: LocalAssistant,
  daemonPort: number,
  options?: DaemonStartOptions,
): Promise<DaemonSpawn | null> {
  const foreground = options?.foreground ?? false;
  const daemonMainPath = resolveDaemonMainPath(assistantIndex);

  // Ensure the directory containing PID/socket files exists. For named
  // instances this is instanceDir/.cadet/workspace/ (matching daemon's getWorkspaceDir()).
  const pidFile = getDaemonPidPath(entry);
  mkdirSync(dirname(pidFile), { recursive: true });

  // --- Lifecycle guard: prevent split-brain daemon state ---
  if (await awaitStartingSentinel(pidFile, daemonPort)) {
    return null;
  }

  const daemonState = await resolveProcessState(
    pidFile,
    daemonPort,
    "Assistant",
    60_000,
    "readyz",
  );
  if (daemonState.status !== "needs_start") {
    logAssistantAlreadyRunning(daemonState.pid, daemonState.status);
    return null;
  }

  if (await checkOrphanedDaemon(pidFile, daemonPort)) {
    return null;
  }

  const env: Record<string, string | undefined> = {
    ...process.env,
    RUNTIME_HTTP_PORT: process.env.RUNTIME_HTTP_PORT || "7821",
    CADET_CLOUD: "local",
    CADET_ENVIRONMENT: process.env.CADET_ENVIRONMENT || "local",
  };
  // "From source" covers both a developer's checkout and the npm-installed
  // runtime the desktop app runs. Only the former is a dev run: marking an
  // installed runtime as dev suppresses its telemetry and skips the
  // `assistant` command install. An inherited CADET_DEV is left alone.
  if (isRepoCheckoutPath(assistantIndex)) {
    env.CADET_DEV = "1";
  }
  applyDaemonEnvOverrides(env, entry, options);

  // Write a sentinel PID file before spawning so concurrent hatch() calls
  // detect the in-progress spawn and wait instead of racing.
  writeFileSync(pidFile, "starting", "utf-8");

  const bunPath = resolveBunExecutable();
  const assistantCommand = findAssistantCommand(assistantIndex);
  const spawnEnv = envWithBunPath(
    env,
    assistantCommand ? [dirname(assistantCommand)] : [],
  );
  const child = foreground
    ? spawn(bunPath, ["run", resolve(daemonMainPath)], {
        cwd: spawnStateRoot(),
        stdio: "inherit",
        env: spawnEnv,
        windowsHide: true,
      })
    : (() => {
        const daemonLogFd = openRuntimeLogFile(
          getLocalInstanceDir(entry),
          "assistant",
        );
        const c = spawn(bunPath, ["run", resolve(daemonMainPath)], {
          cwd: spawnStateRoot(),
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          env: spawnEnv,
        });
        pipeToLogFile(c, daemonLogFd, "daemon");
        c.unref();
        return c;
      })();

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
  if (await awaitStartingSentinel(pidFile, daemonPort)) {
    return null;
  }

  const daemonState = await resolveProcessState(
    pidFile,
    daemonPort,
    "Assistant",
    60_000,
    "readyz",
  );
  if (daemonState.status !== "needs_start") {
    logAssistantAlreadyRunning(daemonState.pid, daemonState.status);
    return null;
  }

  if (await checkOrphanedDaemon(pidFile, daemonPort)) {
    return null;
  }

  const env: Record<string, string | undefined> = {
    ...process.env,
    RUNTIME_HTTP_PORT: process.env.RUNTIME_HTTP_PORT || "7821",
    CADET_DEV: "1",
    CADET_ENVIRONMENT: process.env.CADET_ENVIRONMENT || "local",
  };
  applyDaemonEnvOverrides(env, entry, options);

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

function resolveGatewayDir(
  entry?: LocalAssistant | DockerAssistant | AppleContainerAssistant,
): string {
  const runtimeGatewayDir = localRuntimeGatewayDir(entry);
  if (runtimeGatewayDir) return runtimeGatewayDir;

  // Source tree: cli/src/lib/ → ../../.. → repo root → gateway/
  const sourceDir = join(import.meta.dir, "..", "..", "..", "gateway");
  if (isGatewaySourceDir(sourceDir)) {
    return sourceDir;
  }

  // npm-installed: @mycadet/cli and @mycadet/gateway are siblings
  const npmGatewayDir = join(
    import.meta.dir,
    "..",
    "..",
    "..",
    "cadet-gateway",
  );
  if (isGatewaySourceDir(npmGatewayDir)) {
    return npmGatewayDir;
  }

  // Compiled binary: gateway/ bundled adjacent to the CLI executable.
  const binGateway = join(dirname(process.execPath), "gateway");
  if (isCompiledCli() && isGatewaySourceDir(binGateway)) {
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
 * How to invoke a `gateway <subcommand>` CLI process so it resolves the same
 * workspace AND gateway security dir as the locally spawned gateway server:
 * run the gateway package's CLI entry through bun with the spawn state root
 * as cwd and the instance-pinned CADET_WORKSPACE_DIR / GATEWAY_SECURITY_DIR
 * the server was given (the file-backed pairing store must resolve
 * identically in both processes). Callers pass the resolved assistant
 * entry's `entry` (undefined for the default instance, where both
 * processes fall back to the same cwd-relative paths).
 */
export function gatewayCliInvocation(
  entry?:
    | LocalAssistant
    | DockerAssistant
    | AppleContainerAssistant
    | undefined,
): {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
} {
  return {
    command: resolveBunExecutable(),
    args: ["run", join(resolveGatewayDir(entry), "src/cli/index.ts")],
    cwd: spawnStateRoot(),
    env: {
      ...process.env,
      ...(entry && isLocalEntry(entry)
        ? {
            CADET_WORKSPACE_DIR: join(getLocalInstanceDir(entry), "workspace"),
            GATEWAY_SECURITY_DIR: join(
              getLocalInstanceDir(entry),
              "gateway-security",
            ),
          }
        : {}),
    },
  };
}

function resolveCesDir(
  entry?: LocalAssistant | DockerAssistant | AppleContainerAssistant,
): string {
  const runtimeCesDir = localRuntimeCesDir(entry);
  if (runtimeCesDir) return runtimeCesDir;

  // Source tree / npm sibling: walk up from this file until a
  // `credential-executor/` sibling appears (the file's depth moved when the
  // local remote module landed under remotes/).
  let sourceDir = join(import.meta.dir, "credential-executor");
  let probeDir = import.meta.dir;
  while (!isCesSourceDir(sourceDir) && probeDir !== dirname(probeDir)) {
    probeDir = dirname(probeDir);
    sourceDir = join(probeDir, "credential-executor");
  }
  if (isCesSourceDir(sourceDir)) {
    return sourceDir;
  }

  // npm-installed elsewhere on disk: resolve via the package entry.
  try {
    const pkgPath = _require.resolve(
      "@mycadet/credential-executor/package.json",
    );
    return dirname(pkgPath);
  } catch {
    throw new Error(
      "credential-executor not found. Ensure @mycadet/credential-executor is installed or run from the source tree.",
    );
  }
}

/**
 * Resolve the local IPC endpoint shared by the CLI-launched CES sibling and
 * assistant. CES binds this path from `CES_BOOTSTRAP_SOCKET_DIR` via the same
 * `resolveIpcEndpoint("ces")` helper. Windows uses a named pipe. POSIX uses
 * a Unix socket, including the shared macOS AF_UNIX fallback.
 */
export function resolveCesSocketPath(
  entry?: LocalAssistant | DockerAssistant | AppleContainerAssistant,
  hostPlatform: NodeJS.Platform = platform(),
): string {
  return resolveIpcEndpoint("ces", {
    workspaceDir: resolveCesBootstrapSocketDir(entry),
    platform: hostPlatform,
  }).path;
}

async function isIpcEndpointReady(endpointPath: string): Promise<boolean> {
  if (!isNamedPipePath(endpointPath)) {
    return existsSync(endpointPath);
  }
  return new Promise((resolve) => {
    const socket = new Socket();
    let settled = false;
    const finish = (ready: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ready);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    const timer = setTimeout(() => finish(false), 100);
    socket.connect(endpointPath);
  });
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
  entry?: LocalAssistant | DockerAssistant | AppleContainerAssistant,
): Promise<void> {
  const cadetDir = entry ? getLocalInstanceDir(entry) : resolveDataDir();
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
  const bootstrapDir = resolveCesBootstrapSocketDir(entry);
  mkdirSync(securityDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(bootstrapDir, { recursive: true });

  const cesEnv: Record<string, string | undefined> = {
    ...process.env,
    CREDENTIAL_SECURITY_DIR: securityDir,
    CES_DATA_DIR: dataDir,
    CADET_WORKSPACE_DIR: workspaceDir,
    CES_BOOTSTRAP_SOCKET_DIR: bootstrapDir,
  };

  let ces;
  const runtimeCesDir = !watch ? localRuntimeCesDir(entry) : undefined;
  const cesBinary = compiledSibling("credential-executor");
  if (!runtimeCesDir && isCompiledCli() && existsSync(cesBinary) && !watch) {
    // Compiled binary alongside the CLI (desktop app / compiled CLI).
    const cesLogFd = openLogFile("hatch.log");
    ces = spawn(cesBinary, [], {
      cwd: spawnStateRoot(),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: cesEnv,
    });
    pipeToLogFile(ces, cesLogFd, "credential-executor");
  } else {
    // Source tree / bunx: run the CES entry point via bun.
    const cesDir = runtimeCesDir ?? resolveCesDir(entry);
    const cesEntry = join(cesDir, "src/main.ts");
    const bunArgs = watch ? ["--watch", "run", cesEntry] : ["run", cesEntry];
    const cesLogFd = openLogFile("hatch.log");
    ces = spawn(resolveBunExecutable(), bunArgs, {
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
  }

  ces.unref();

  if (ces.pid) {
    mkdirSync(cadetDir, { recursive: true });
    writeFileSync(cesPidFile, String(ces.pid), "utf-8");
  }

  // Wait for the endpoint so the daemon's discovery finds it on the
  // first probe rather than burning its retry budget. A cold start (fresh
  // install, antivirus scanning the binary) can be slow, so give it a
  // minute and say so every 10 seconds instead of failing at 10.
  const startedAt = Date.now();
  const deadline = startedAt + 60_000;
  let nextProgressLog = startedAt + 10_000;
  let endpointReady = false;
  while (Date.now() < deadline) {
    endpointReady = await isIpcEndpointReady(socketPath);
    if (endpointReady) {
      break;
    }
    if (Date.now() >= nextProgressLog) {
      console.warn(
        `⚠ credential-executor socket not ready after ${Math.round((Date.now() - startedAt) / 1000)}s — still waiting`,
      );
      nextProgressLog += 10_000;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!endpointReady) {
    console.warn(
      `⚠ credential-executor socket did not appear within 60s — its output is logged in ${join(resolveLogDir(), "hatch.log")}`,
    );
  } else {
    startupLog("✅ credential-executor started\n");
  }
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
 * Recover PID tracking for a daemon that is already responsive on its HTTP
 * port but whose PID file is stale or missing. Looks up the listener PID
 * via `lsof` and writes it to `pidFile` so lifecycle commands (sleep, retire,
 * wake) can target the running process.
 *
 * Returns the recovered PID, or undefined if recovery failed.
 */
function recoverPidFile(
  pidFile: string,
  daemonPort: number,
): number | undefined {
  const pid = findPidListeningOnPort(daemonPort);
  if (pid) {
    mkdirSync(dirname(pidFile), { recursive: true });
    writeFileSync(pidFile, String(pid), "utf-8");
  }
  return pid;
}

/**
 * Handle the "starting" sentinel in a PID file. When another caller is
 * already spawning the daemon, wait for it to become ready instead of
 * racing to spawn a duplicate.
 *
 * Returns `true` if the daemon became ready (caller should return early),
 * `false` if the spawn failed or the sentinel wasn't present (caller
 * should proceed). Cleans up the PID file on failure.
 */
async function awaitStartingSentinel(
  pidFile: string,
  daemonPort: number,
): Promise<boolean> {
  if (!existsSync(pidFile)) return false;
  try {
    const content = readFileSync(pidFile, "utf-8").trim();
    if (content !== "starting") return false;
  } catch {
    return false;
  }

  console.log("   Assistant is starting — waiting for it to become ready...");
  const readiness = await waitForDaemonMigrationsReady(
    daemonPort,
    Date.now() + 60000,
  );
  if (readiness !== "unreachable") {
    // The daemon exists and is answering — migrating and failed states must
    // NOT fall through to a second spawn (split-brain). Report honestly.
    logDaemonReadiness(readiness);
    return true;
  }
  try {
    unlinkSync(pidFile);
  } catch {}
  return false;
}

/**
 * Check if a daemon without a valid PID file is still reachable on its
 * HTTP port (orphaned process). If so, recover its PID file so lifecycle
 * commands can manage it.
 *
 * Returns `true` if an orphaned daemon was found (caller should skip
 * starting a new one), `false` otherwise.
 */
async function checkOrphanedDaemon(
  pidFile: string,
  daemonPort: number,
): Promise<boolean> {
  if (!(await httpHealthCheck(daemonPort))) return false;

  const recoveredPid = recoverPidFile(pidFile, daemonPort);
  if (recoveredPid) {
    console.log(
      `   Assistant is responsive (pid ${recoveredPid}) — skipping restart\n`,
    );
  } else {
    console.log("   Assistant is responsive — skipping restart\n");
  }
  return true;
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
 * Check whether watch-mode startup is possible for the assistant daemon.
 * Watch mode requires source files (bun --watch only works with .ts sources,
 * not compiled binaries). Returns true when assistant source can be resolved,
 * false otherwise.
 *
 * Use this before stopping a running assistant for a watch-mode restart — if
 * watch mode isn't available (e.g. packaged desktop app without source), the
 * caller should keep the existing process alive rather than killing it and
 * failing.
 */
export function isAssistantWatchModeAvailable(): boolean {
  return resolveAssistantIndexPath() !== undefined;
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
  const basePorts = getDefaultPorts();
  const daemonPort = await findAvailablePort(basePorts.daemon);

  const runtimeAssistantIndex = !watch
    ? localRuntimeAssistantIndex(entry)
    : undefined;
  if (runtimeAssistantIndex) {
    startupLog("🔨 Starting local assistant runtime...");
    // Wait for readiness only after an actual spawn — an attach to an
    // already-running daemon was classified and logged inside
    // startDaemonFromSource, and re-waiting would just block on a migration
    // the user was already told about.
    const runtimeSpawn = await startDaemonFromSource(
      runtimeAssistantIndex,
      entry,
      daemonPort,
      options,
    );
    if (runtimeSpawn) {
      await reportFreshSpawnReadiness(
        runtimeSpawn,
        getDaemonPidPath(entry),
        daemonPort,
        await waitForDaemonMigrationsReady(daemonPort, Date.now() + 60000),
        options?.requireReady,
      );
    }
    return;
  }

  const foreground = options?.foreground ?? false;
  // Check for a compiled daemon binary adjacent to the CLI executable.
  // This covers both the desktop app (CADET_DESKTOP_APP) and the case where
  // the user runs the compiled CLI directly from the terminal (e.g. via a
  // /usr/local/bin/cadet symlink into the app bundle).
  const daemonBinary = compiledSibling("cadet-daemon");
  if (isCompiledCli() && existsSync(daemonBinary) && !watch) {
    // In watch mode, skip the bundled binary and use source (bun --watch
    // only works with source files, not compiled binaries).

    const pidFile = getDaemonPidPath(entry);

    // --- Lifecycle guard: prevent split-brain daemon state ---
    if (await awaitStartingSentinel(pidFile, daemonPort)) {
      ensureBunInstalled();
      return;
    }

    const daemonState = await resolveProcessState(
      pidFile,
      daemonPort,
      "Assistant",
      60_000,
      "readyz",
    );
    const daemonAlive = daemonState.status !== "needs_start";
    if (daemonAlive) {
      logAssistantAlreadyRunning(daemonState.pid, daemonState.status);
    }
    let daemonSpawn: DaemonSpawn | null = null;

    if (!daemonAlive) {
      if (await checkOrphanedDaemon(pidFile, daemonPort)) {
        ensureBunInstalled();
        // The orphan already answers health checks — a readiness probe
        // classifies it without blocking on an in-flight migration.
        logDaemonReadiness(
          await probeDaemonReadinessWithRetry(daemonPort),
          options?.requireReady,
        );
        return;
      }

      console.log("🔨 Starting assistant...");

      // Ensure bun is available for runtime features (browser, skills install)
      ensureBunInstalled();

      // Ensure the directory containing PID files exists
      mkdirSync(dirname(pidFile), { recursive: true });

      // Build a minimal environment for the daemon. When launched from the
      // macOS app the CLI inherits a huge environment (XPC_SERVICE_NAME,
      // __CFBundleIdentifier, etc.) that can cause
      // the daemon to take 50+ seconds to start instead of ~1s.
      const home = homedir();
      const bunBinDir = join(home, ".bun", "bin");
      const localBinDir = join(home, ".local", "bin");
      const basePath = process.env.PATH || DEFAULT_EXECUTABLE_PATH;
      // The compiled `assistant` ships beside the daemon binary, so its
      // directory is what puts `assistant …` on PATH for agent-run commands.
      const daemonBinaryDir = dirname(daemonBinary);
      const assistantBinaryDir = existsSync(
        join(daemonBinaryDir, executableName("assistant", platform())),
      )
        ? [daemonBinaryDir]
        : [];
      const extraDirs = [...assistantBinaryDir, bunBinDir, localBinDir].filter(
        (d) => !basePath.split(PATH_DELIMITER).includes(d),
      );
      const daemonEnv: Record<string, string> = {
        HOME: process.env.HOME || home,
        PATH: [...extraDirs, basePath].filter(Boolean).join(PATH_DELIMITER),
      };
      if (platform() === "win32") {
        for (const key of [
          "APPDATA",
          "COMSPEC",
          "LOCALAPPDATA",
          "PATHEXT",
          "SystemDrive",
          "SystemRoot",
          "TEMP",
          "TMP",
          "USERPROFILE",
        ]) {
          if (process.env[key]) {
            daemonEnv[key] = process.env[key];
          }
        }
      }
      // Forward optional config env vars the daemon may need.
      // `CADET_ENVIRONMENT` must be forwarded so the daemon resolves
      // env-scoped paths (device ID, platform/guardian tokens, XDG
      // config dir) to the same location as the CLI that spawned it.
      for (const key of [
        "ANTHROPIC_API_KEY",
        "APP_VERSION",
        "CADET_ENVIRONMENT",
        "CADET_CLOUD_URL",
        "QDRANT_HTTP_PORT",
        "QDRANT_URL",
        "RUNTIME_HTTP_PORT",
        "TMPDIR",
        "USER",
        "LANG",
        "CADET_DEBUG",
        "CADET_DEV",
        "CADET_DESKTOP_APP",
        "CADET_MIGRATION_EXPORT_ALLOWED_HOSTS",
        "CADET_MIGRATION_IMPORT_ALLOWED_HOSTS",
        "CADET_WORKSPACE_DIR",
      ]) {
        if (process.env[key]) {
          daemonEnv[key] = process.env[key]!;
        }
      }
      applyDaemonEnvOverrides(daemonEnv, entry, options);
      const daemonSpawnEnv = envWithCompiledRuntimeNodePath(daemonEnv);

      // Write a sentinel PID file before spawning so concurrent hatch() calls
      // see the file and fall through to the httpHealthCheck() port check
      // instead of racing to spawn a duplicate daemon.
      writeFileSync(pidFile, "starting", "utf-8");

      const child = foreground
        ? spawn(daemonBinary, [], {
            cwd: spawnStateRoot(),
            stdio: "inherit",
            env: daemonSpawnEnv,
            windowsHide: true,
          })
        : (() => {
            const daemonLogFd = openRuntimeLogFile(
              getLocalInstanceDir(entry),
              "assistant",
            );
            const c = spawn(daemonBinary, [], {
              cwd: spawnStateRoot(),
              detached: true,
              stdio: ["ignore", "pipe", "pipe"],
              windowsHide: true,
              env: daemonSpawnEnv,
            });
            pipeToLogFile(c, daemonLogFd, "daemon");
            c.unref();
            return c;
          })();
      const daemonPid = child.pid;

      // Overwrite sentinel with real PID, or clean up on spawn failure.
      if (daemonPid) {
        writeFileSync(pidFile, String(daemonPid), "utf-8");
        daemonSpawn = trackDaemonSpawn(child);
      } else {
        try {
          unlinkSync(pidFile);
        } catch {}
      }
    }

    // Ensure bun is available for runtime features (browser, skills install)
    // Runs after daemon-reuse checks so the fast attach path is not blocked
    // by a potentially slow bun install when the daemon is already alive.
    if (daemonAlive) {
      ensureBunInstalled();
    }

    // Wait for daemon to respond on HTTP (up to 60s — fresh installs
    // may need 30-60s for Qdrant download, migrations, and first-time init).
    // "migrating" and "failed" both mean the daemon is up and answering, so
    // they don't trigger the source fallback (a restart against the same DB
    // would reproduce the same migration state).
    //
    // Runs only after a fresh spawn: an attached daemon was already
    // classified and logged by resolveProcessState above, and re-waiting on
    // its in-flight migration would just double the reported diagnosis.
    if (!daemonAlive) {
      let readiness = await waitForDaemonMigrationsReady(
        daemonPort,
        Date.now() + 60000,
      );
      const daemonHealthy =
        readiness !== "unreachable" || (await httpHealthCheck(daemonPort));

      // Dev fallback: if the bundled daemon did not become healthy in time,
      // fall back to source daemon startup so local source runs still work.
      if (!daemonHealthy) {
        const assistantIndex = resolveAssistantIndexPath(entry);
        if (assistantIndex) {
          console.log(
            "   Bundled assistant not healthy after 60s, falling back to source assistant...",
          );
          // Kill the bundled daemon to avoid two processes competing for the
          // same port. It gets the full stop budget like any other daemon:
          // failing the health probe does not mean it has nothing to flush, and
          // a daemon still working through a long DB migration is exactly the
          // one whose WAL checkpoint must not be interrupted.
          await stopProcessByPidFile(
            pidFile,
            "bundled daemon",
            undefined,
            DAEMON_STOP_TIMEOUT_MS,
          );
          daemonSpawn = watch
            ? await startDaemonWatchFromSource(
                assistantIndex,
                entry,
                daemonPort,
                options,
              )
            : await startDaemonFromSource(
                assistantIndex,
                entry,
                daemonPort,
                options,
              );
          readiness = await waitForDaemonMigrationsReady(
            daemonPort,
            Date.now() + 60000,
          );
        }
      } else if (readiness === "unreachable") {
        // The health check just passed, so the readyz probes were the flaky
        // part — re-probe once so the log reports the daemon's real state
        // instead of "did not become ready".
        readiness = await probeDaemonReadiness(daemonPort);
      }

      if (daemonSpawn) {
        await reportFreshSpawnReadiness(
          daemonSpawn,
          pidFile,
          daemonPort,
          readiness,
          options?.requireReady,
        );
      } else {
        logDaemonReadiness(readiness, options?.requireReady);
      }
    }
  } else {
    startupLog("🔨 Starting local assistant...");

    const assistantIndex = resolveAssistantIndexPath(entry);
    if (!assistantIndex) {
      throw new Error(
        "cadet-daemon binary not found and assistant source not available.\n" +
          "  Ensure the daemon binary is bundled alongside the CLI, or run from the source tree.",
      );
    }
    const sourceSpawn = watch
      ? await startDaemonWatchFromSource(
          assistantIndex,
          entry,
          daemonPort,
          options,
        )
      : await startDaemonFromSource(assistantIndex, entry, daemonPort, options);
    // Attach case was classified and logged inside the start function.
    if (sourceSpawn) {
      await reportFreshSpawnReadiness(
        sourceSpawn,
        getDaemonPidPath(entry),
        daemonPort,
        await waitForDaemonMigrationsReady(daemonPort, Date.now() + 60000),
        options?.requireReady,
      );
    }
  }
}

export async function startGateway(
  watch: boolean = false,
  entry?: LocalAssistant | DockerAssistant | AppleContainerAssistant,
  options?: {
    bootstrapSecret?: string;
    requireReady?: boolean;
  },
): Promise<string> {
  const effectiveGatewayPort = entry?.port ?? GATEWAY_PORT;

  // Kill any existing gateway process before spawning a new one.
  // Without this, crashed/stale gateways accumulate as zombies — the old
  // process holds the port (or lingers after losing it), and every restart
  // attempt spawns yet another process that fails with EADDRINUSE.
  const gwPidDir = entry ? getLocalInstanceDir(entry) : resolveDataDir();
  const gwPidFile = join(gwPidDir, "gateway.pid");
  await stopProcessByPidFile(gwPidFile, "gateway");

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
    ...(options?.bootstrapSecret
      ? { GUARDIAN_BOOTSTRAP_SECRET: options.bootstrapSecret }
      : {}),
    ...(watch
      ? {
          CADET_DEV: "1",
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

  let gateway;

  const runtimeGatewayDir = !watch ? localRuntimeGatewayDir(entry) : undefined;
  const gatewayBinary = compiledSibling("cadet-gateway");
  if (
    !runtimeGatewayDir &&
    isCompiledCli() &&
    existsSync(gatewayBinary) &&
    !watch
  ) {
    // Use the compiled gateway binary when available (desktop app or compiled
    // CLI invoked from the terminal). In watch mode, skip the bundled binary
    // and use source (bun --watch only works with source files).
    const gatewayLogFd = openRuntimeLogFile(
      getLocalInstanceDir(entry),
      "gateway",
    );
    gateway = spawn(gatewayBinary, [], {
      cwd: spawnStateRoot(),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: envWithCompiledRuntimeNodePath(gatewayEnv),
    });
    pipeToLogFile(gateway, gatewayLogFd, "gateway");
  } else {
    // Source tree / bunx: resolve the gateway source directory and run via bun.
    const gatewayDir = runtimeGatewayDir ?? resolveGatewayDir(entry);
    const gatewayEntry = join(gatewayDir, "src/index.ts");
    const bunArgs = watch
      ? ["--watch", "run", gatewayEntry, "--cadet-gateway"]
      : ["run", gatewayEntry, "--cadet-gateway"];
    const gwLogFd = openRuntimeLogFile(getLocalInstanceDir(entry), "gateway");
    gateway = spawn(resolveBunExecutable(), bunArgs, {
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
  }

  gateway.unref();

  if (gateway.pid) {
    const gwPidDir = entry ? getLocalInstanceDir(entry) : resolveDataDir();
    writeFileSync(join(gwPidDir, "gateway.pid"), String(gateway.pid), "utf-8");
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

/**
 * Stop any locally-running daemon and gateway processes
 * and clean up PID files. Called when hatch fails partway through
 * so we don't leave orphaned processes with no lock file entry.
 *
 * When `entry` is provided, uses instance-specific paths instead of
 * the default ~/.cadet/ paths.
 */
export async function stopLocalProcesses(
  entry?: LocalAssistant | DockerAssistant | AppleContainerAssistant,
): Promise<void> {
  const cadetDir = entry ? getLocalInstanceDir(entry) : resolveDataDir();
  const daemonPidFile = getDaemonPidPath(entry);
  await stopProcessByPidFile(
    daemonPidFile,
    "daemon",
    undefined,
    DAEMON_STOP_TIMEOUT_MS,
    stopProcessGracefully,
  );

  const gatewayPidFile = join(cadetDir, "gateway.pid");
  await stopProcessByPidFile(
    gatewayPidFile,
    "gateway",
    undefined,
    7000,
    stopProcessGracefully,
  );

  // Stop the CES sibling if one was launched. No-op when the
  // PID file is absent.
  const cesPidFile = join(cadetDir, "ces.pid");
  await stopProcessByPidFile(
    cesPidFile,
    "credential-executor",
    undefined,
    DAEMON_STOP_TIMEOUT_MS,
    stopProcessGracefully,
  );
}

/**
 * Attempts to place a symlink at the given path pointing to cliBinary.
 * Returns true if the symlink was created (or already correct), false on failure.
 */
function trySymlink(cliBinary: string, symlinkPath: string): boolean {
  try {
    // Use lstatSync (not existsSync) to detect dangling symlinks —
    // existsSync follows symlinks and returns false for broken links.
    try {
      const stats = lstatSync(symlinkPath);
      if (!stats.isSymbolicLink()) {
        // Real file — don't overwrite (developer's local install)
        return false;
      }
      // Already a symlink — skip if it already points to our binary
      const dest = readlinkSync(symlinkPath);
      if (dest === cliBinary) return true;
      // Stale or dangling symlink — remove before creating new one
      unlinkSync(symlinkPath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") return false;
      // Path doesn't exist — proceed to create symlink
    }

    const dir = join(symlinkPath, "..");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    symlinkSync(cliBinary, symlinkPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensures ~/.local/bin is present in the user's shell profile so that
 * symlinks placed there are on PATH in new terminal sessions.
 */
function ensureLocalBinInShellProfile(localBinDir: string): void {
  const shell = process.env.SHELL ?? "";
  const home = homedir();
  // Determine the appropriate shell profile to modify
  const profilePath = shell.endsWith("/zsh")
    ? join(home, ".zshrc")
    : shell.endsWith("/bash")
      ? join(home, ".bash_profile")
      : null;
  if (!profilePath) return;

  try {
    const contents = existsSync(profilePath)
      ? readFileSync(profilePath, "utf-8")
      : "";
    // Check if ~/.local/bin is already referenced in PATH exports
    if (contents.includes(localBinDir)) return;
    const line = `\nexport PATH="${localBinDir}:\$PATH"\n`;
    appendFileSync(profilePath, line);
    console.log(`   Added ${localBinDir} to ${profilePath}`);
  } catch {
    // Not critical — user can add it manually
  }
}

function installCLISymlink(): void {
  const cliBinary = process.execPath;
  if (!cliBinary || !existsSync(cliBinary)) return;

  // Preferred location — works on most Macs where /usr/local/bin exists
  const preferredPath = "/usr/local/bin/cadet";
  if (trySymlink(cliBinary, preferredPath)) {
    console.log(`   Symlinked ${preferredPath} → ${cliBinary}`);
    return;
  }

  // Fallback — use ~/.local/bin which is user-writable and doesn't need root.
  // On some Macs /usr/local doesn't exist and creating it requires admin privileges.
  const localBinDir = join(homedir(), ".local", "bin");
  const fallbackPath = join(localBinDir, "cadet");
  if (trySymlink(cliBinary, fallbackPath)) {
    console.log(`   Symlinked ${fallbackPath} → ${cliBinary}`);
    ensureLocalBinInShellProfile(localBinDir);
    return;
  }

  console.log(
    `   ⚠ Could not create symlink for cadet CLI (tried ${preferredPath} and ${fallbackPath})`,
  );
}

export interface HatchLocalParams {
  /** Instance display name. Defaults to an auto-generated name. */
  name?: string | null;
  /** Build from a local source tree and hot-reload on change. */
  watch?: boolean;
  /** Hatch-time config values (key → value). */
  configValues?: Record<string, string>;
  setupProviderCredentials?: boolean;
  /** Whole-installation state installed before the first service startup. */
  initialArchive?: string;
  /**
   * Show the per-service startup logs (assistant, credential executor,
   * gateway) and the extended next steps. Off by default — the happy path
   * ends at the hatched summary.
   */
  verbose?: boolean;
  /**
   * Sink for progress and log output. Defaults to the console reporter so CLI
   * callers keep their existing terminal output; in-process callers can inject
   * their own reporter to consume progress without writing to stdout.
   */
  reporter?: LifecycleReporter;
}

export interface HatchLocalResult {
  assistantId: string;
  /**
   * Guardian access token leased during hatch, when the lease succeeded. The
   * full token pair is persisted to disk regardless; this is surfaced so an
   * in-process caller can prime a connection without re-reading the file.
   */
  guardianAccessToken?: string;
}

export async function hatchLocal(
  params: HatchLocalParams = {},
): Promise<HatchLocalResult> {
  const { name, watch = false, configValues = {} } = params;
  const reporter = params.reporter ?? consoleLifecycleReporter;
  const verbose = params.verbose ?? false;
  const setupProviderCredentials = params.setupProviderCredentials !== false;
  setStartupLogging(verbose);
  let provider = setupProviderCredentials
    ? resolveHatchProvider(configValues)
    : undefined;
  const instanceName = generateInstanceName(
    name ?? process.env.CADET_ASSISTANT_NAME,
  );
  // Collected inside the lock (right after the provider choice, so the two
  // prompts sit back-to-back), consumed after the guardian token leases.
  let precollectedApiKey: string | undefined;

  const { entry } = await withLocalHatchLock(async () => {
    reporter.progress(1, 6, "Allocating resources...");

    const existing = findAssistantByName(instanceName);
    if (existing && (!existing.cloud || existing.cloud === "local")) {
      throw new Error(
        `An assistant named "${instanceName}" is already hatched.\n` +
          `Run \`cadet wake\` to restart it, or \`cadet retire ${instanceName}\` to remove it first.`,
      );
    }

    const entry: LockfileAssistant = {
      assistantId: instanceName,
      cloud: "local",
      ...(await allocateLocalPlacement(instanceName)),
    };

    reporter.log(`🥚 Hatching local assistant: ${instanceName}`);
    reporter.log("");

    const apiKeyCheck = checkProviderApiKey();
    let pickedProvider = false;
    if (
      shouldPromptForHatchProvider({
        configValues,
        setupProviderCredentials,
        hasProviderApiKey: apiKeyCheck.hasKey,
        stdinIsTTY: process.stdin.isTTY,
      })
    ) {
      const picked = await promptProviderChoice();
      if (picked) {
        provider = picked;
        pickedProvider = true;
        // Collect the key immediately, while the choice is fresh — the
        // startup logs are quiet now, so nothing separates the two prompts.
        precollectedApiKey = await collectProviderApiKey(picked);

        // Picking Cadet Cloud should feel like signing in, not like a
        // mystery later — open the browser login right here. Skipped for
        // the desktop app (it runs its own login UI) and non-TTY runs.
        if (
          picked === "cadet" &&
          !process.env.CADET_DESKTOP_APP &&
          process.stdin.isTTY &&
          !readCloudToken()
        ) {
          reporter.log("");
          reporter.log(
            "Cadet Cloud selected — opening your browser to log in...",
          );
          try {
            await ensureCloudLoginInteractive();
            reporter.log("✅ Logged in to Cadet Cloud");
          } catch (error) {
            reporter.warn(
              `⚠️  Cadet Cloud login failed: ${describeLoginError(error)}`,
            );
            reporter.warn("   You can retry later with `cadet login`.");
          }
        }
      }
    }

    if (
      !apiKeyCheck.hasKey &&
      !pickedProvider &&
      !process.env.CADET_DESKTOP_APP
    ) {
      reporter.warn(
        "Warning: No LLM provider API key is configured. The assistant will fail when you try to send a message.",
      );
      reporter.warn("  To fix, export your key before running cadet hatch:");
      reporter.warn("  export ANTHROPIC_API_KEY=<your-key>");
      reporter.warn("");
    }

    if (!process.env.APP_VERSION) {
      process.env.APP_VERSION = cliPkg.version;
    }

    reporter.progress(2, 6, "Setting up local assistant...");
    const hatchConfigValues = buildHatchConfigValues(configValues, provider);
    const defaultWorkspaceConfigPath = writeInitialConfig(hatchConfigValues);

    reporter.progress(3, 6, "Starting assistant...");
    if (params.initialArchive) {
      // Restores the archived state roots — gateway-security included, so
      // the gateway boots with the archived signing identity.
      await (
        await import("../root-backup.js")
      ).initializeRootArchive(entry, params.initialArchive);
    }
    const bootstrapSecret = generateLocalSecret();
    saveGuardianBootstrapSecret(instanceName, bootstrapSecret);
    try {
      // Launch the CES sibling alongside the daemon, in parallel — matching the
      // Docker topology. The assistant does not spawn its own CES, so a freshly
      // hatched instance would otherwise come up with CES unavailable.
      // startCes always launches the CES sibling.
      const startupResults = await Promise.allSettled([
        startCes(watch, entry),
        startLocalDaemon(watch, entry, {
          defaultWorkspaceConfigPath,
          requireReady: true,
        }),
      ]);
      const startupFailure = startupResults.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (startupFailure) {
        throw startupFailure.reason;
      }

      reporter.progress(4, 6, "Starting gateway...");
      await startGateway(watch, entry, {
        bootstrapSecret,
        requireReady: true,
      });
    } catch (error) {
      reporter.error(
        `\n❌ Local assistant startup failed — stopping partial processes.`,
      );
      reporter.error(
        `   Logs: ${join(getLocalInstanceDir(entry), "logs")} and ${join(resolveLogDir(), "hatch.log")}`,
      );
      await stopLocalProcesses(entry);
      throw error;
    }

    entry.hatchedAt = new Date().toISOString();

    reporter.progress(5, 6, "Saving configuration...");
    saveLockfileAssistant(entry);
    setActiveAssistant(instanceName);

    return { entry };
  });

  // Lease a guardian token so the desktop app can import it on first launch
  // instead of hitting /v1/guardian/init itself.
  reporter.progress(6, 6, "Securing connection...");
  const maxLeaseAttempts = 3;
  let guardianAccessToken: string | undefined;
  for (let attempt = 1; attempt <= maxLeaseAttempts; attempt++) {
    try {
      const tokenData = await leaseGuardianToken(entry);
      guardianAccessToken = tokenData.accessToken;
      break;
    } catch (err) {
      if (
        attempt < maxLeaseAttempts &&
        !(err instanceof GuardianLeasePermanentError)
      ) {
        const delayMs = 2000 * 2 ** (attempt - 1);
        reporter.error(
          yellow(
            `⚠️  Guardian token lease attempt ${attempt}/${maxLeaseAttempts} failed — retrying in ${delayMs / 1000}s: ${err}`,
          ),
        );
        await new Promise((r) => setTimeout(r, delayMs));
      } else {
        reporter.error(
          yellow(
            `⚠️  Guardian token lease failed${err instanceof GuardianLeasePermanentError ? ", not retrying — a malformed 200 will not fix itself" : ` after ${maxLeaseAttempts} attempts`}: ${err}\n` +
              `   The assistant is running but guardian-token.json was not written.\n` +
              `   Run \`cadet restart ${JSON.stringify(instanceName)} --repair-guardian\` to re-lease a token.`,
          ),
        );
      }
    }
  }

  if (process.env.CADET_DESKTOP_APP) {
    installCLISymlink();
  }

  if (provider !== undefined && provider !== null && !guardianAccessToken) {
    reporter.error(
      yellow(
        `⚠️  Provider credential setup skipped because the guardian token was not leased.\n` +
          `   The assistant is still hatched. Run \`cadet setup --provider ${provider}\` after fixing the connection.`,
      ),
    );
  } else if (provider !== undefined) {
    await configureHatchProviderApiKey({
      gatewayUrl: getGatewayUrl(entry),
      provider,
      bearerToken: guardianAccessToken,
      env: process.env,
      precollectedKey: precollectedApiKey,
    });
  }

  // Picking Cadet Cloud ends with the assistant registered on the cloud
  // and its cloud credentials injected — the same post-login flow
  // `cadet login` runs — so messages route through the cloud connection
  // immediately after hatch. Non-fatal: the assistant is up either way.
  const cloudToken = readCloudToken();
  if (provider === "cadet" && cloudToken) {
    try {
      const user = await fetchCurrentUser(cloudToken);
      await registerLocalAssistantWithCloud(user, (m) => reporter.log(m));
    } catch {
      // Non-fatal — `cadet login` can complete the registration later.
    }
  }

  reporter.log("");
  reporter.log(green(`✅ Local assistant hatched!`, process.stdout));
  printInstanceDetails(
    {
      name: instanceName,
      runtime: getGatewayUrl(entry),
      root: entry.instanceDir,
    },
    (message) => reporter.log(message),
  );
  logHatchNextSteps((message) => reporter.log(message));

  const result: HatchLocalResult = {
    assistantId: instanceName,
    guardianAccessToken,
  };

  return result;
}

/**
 * Marks a deliberate per-assistant wake refusal (an unmanageable runtime, a
 * daemon that died during startup). The single-assistant path renders it as
 * the same "Error: …" + exit 1 the command always printed; `--all` treats it
 * as one entry's failure and keeps waking the rest.
 */
export class WakeExit extends Error {}

/**
 * Start a local-runtime assistant's daemon, CES sibling, and gateway. The
 * command layer's local branch of `cadet wake` — every local-runtime
 * decision (port heal, attach-or-spawn, gateway restart, migration wait)
 * lives here with the rest of the local remote's lifecycle methods.
 */
export async function wakeLocal(
  entry: LockfileAssistant,
  opts: { watch: boolean; foreground: boolean },
): Promise<void> {
  const { watch, foreground } = opts;
  if (!isLocalEntry(entry)) {
    throw new WakeExit(
      `'${entry.assistantId}' is not an on-machine assistant.`,
    );
  }

  const basePorts = getDefaultPorts();
  const daemonPort = await findAvailablePort(basePorts.daemon);

  // Port auto-heal: a recorded port something else holds (a still-running
  // vellum assistant on the pre-de-clash ports, a stray listener) used to
  // kill the daemon on EADDRINUSE — or worse, leave a foreign listener
  // answering this wake's health probes. Move the entry off foreign-held
  // ports before anything binds, and say so loudly. Ports held by our own
  // processes are left for the orphan path to adopt. Local only: docker
  // ports are published by existing containers and need a recreate, which
  // the docker path below reports on its own.
  const portHeal = await healConflictedLocalPorts(entry);
  if (portHeal) {
    saveLockfileAssistant(entry);
    for (const move of portHeal.moves) {
      console.warn(
        yellow(
          `⚠️  ${entry.assistantId}: ${move.field} ${move.from} is held by another process — moved to ${move.to}.`,
        ),
      );
    }
  }

  const pidFile = getDaemonPidPath(entry);

  // Budget anchor for the migration-coordination wait below: the host
  // wrapper (packages/local-mode/src/wake.ts WAKE_TIMEOUT_MS) SIGTERMs wake
  // after 180s, and the hung-daemon health wait + post-spawn wait + gateway
  // start can already consume most of that.
  const wakeStartedAt = Date.now();

  let daemonRunning = false;
  let daemonUnready = false;
  let daemonMigrationsFailed = false;
  const daemonState = await resolveProcessState(
    pidFile,
    daemonPort,
    "Assistant",
    60_000,
    "readyz",
  );
  if (daemonState.status !== "needs_start") {
    if (daemonState.status === "stuck") {
      daemonRunning = true;
      daemonUnready = true;
      console.log(
        `Assistant running (pid ${daemonState.pid}) but is not responding and could not be stopped.`,
      );
    } else if (watch && isAssistantWatchModeAvailable()) {
      console.log(
        `Assistant running (pid ${daemonState.pid}) — restarting in watch mode...`,
      );
      const stopped = await stopProcessByPidFile(
        pidFile,
        "assistant",
        undefined,
        DAEMON_STOP_TIMEOUT_MS,
      );
      if (!stopped && isProcessAlive(pidFile).alive) {
        daemonRunning = true;
        daemonUnready = true;
        console.log(
          `Assistant running (pid ${daemonState.pid}) but could not be stopped for watch mode.`,
        );
      }
    } else {
      daemonRunning = true;
      daemonUnready = daemonState.status !== "healthy";
      daemonMigrationsFailed = daemonState.status === "migration_failed";
      if (watch) {
        console.log(
          `Assistant running (pid ${daemonState.pid}) — watch mode not available, no source files. Keeping existing process.`,
        );
      } else if (daemonMigrationsFailed) {
        console.log(
          `Assistant running (pid ${daemonState.pid}) but its database migrations failed.`,
        );
      } else if (daemonUnready) {
        console.log(
          `Assistant running (pid ${daemonState.pid}) — database migrations still running.`,
        );
      } else {
        console.log(`Assistant already running (pid ${daemonState.pid}).`);
      }
    }
  }

  let bootstrapSecret = loadGuardianBootstrapSecret(entry.assistantId);
  let bootstrapSecretBackfilled = false;
  if (!bootstrapSecret) {
    bootstrapSecret = generateLocalSecret();
    saveGuardianBootstrapSecret(entry.assistantId, bootstrapSecret);
    bootstrapSecretBackfilled = true;
  }

  if (!daemonRunning) {
    // Spin up CES and the daemon in parallel, the way the Docker topology
    // brings its sibling containers up together — the assistant polls for the
    // CES socket during startup (discoverCesWithRetry), so it tolerates CES
    // still binding. CES's lifecycle tracks the daemon (its only consumer):
    // restarting it under a live daemon would sever the daemon's open
    // connection, so it is only (re)started alongside the daemon. startCes
    // always launches the CES sibling unconditionally.
    await Promise.all([
      startCes(watch, entry),
      startLocalDaemon(watch, entry, { foreground }),
    ]);
    // A daemon that aborts during startup (an occupied runtime HTTP port, a
    // fatal subsystem failure) leaves no process behind, and readiness alone
    // cannot see that: whatever foreign listener holds the port answers the
    // probe in its place. Liveness is the authoritative signal, so check it
    // first and fail the command instead of reporting a successful wake for
    // an assistant that is not running.
    if (!isProcessAlive(pidFile).alive) {
      throw new WakeExit(
        `the assistant exited during startup and is not running. Its runtime HTTP port ${daemonPort} may be held by another process (check \`lsof -i :${daemonPort}\`); the daemon log records the startup error it reported.`,
      );
    }
    // startLocalDaemon's post-spawn wait is bounded (60s), and a longer
    // migration outlives it. Classify the fresh spawn the same way the
    // attach path does, so the gateway-coordination wait below applies to
    // both paths and wake's closing summary stays honest.
    const readiness = await probeDaemonReadinessWithRetry(daemonPort);
    daemonUnready = readiness === "migrating";
    daemonMigrationsFailed = readiness === "failed";
  } else {
    // Self-heal: the daemon is already healthy, but the CES sibling may have
    // died independently (crash, OOM kill). A dead ces.pid under a live daemon
    // means credential operations will fail until the next wake. Relaunch the
    // sibling so the daemon's lazy reconnect (secure-keys.ts) picks it up on
    // the next credential read. startCes always launches the sibling.
    const cadetDir = getLocalInstanceDir(entry);
    const cesPidFile = join(cadetDir, "ces.pid");
    const cesAlive = isProcessAlive(cesPidFile).alive;
    if (!cesAlive) {
      console.log("CES sibling not running — relaunching...");
      await startCes(watch, entry);
    }
  }

  // Start gateway
  let gatewayStarted = false;
  {
    const cadetDir = getLocalInstanceDir(entry);
    const gatewayPidFile = join(cadetDir, "gateway.pid");
    const gatewayState = await resolveProcessState(
      gatewayPidFile,
      entry.port ?? GATEWAY_PORT,
      "Gateway",
    );
    const gatewayAlive = gatewayState.status === "healthy";
    const gatewayStuck = gatewayState.status === "stuck";
    const restartGateway = async (
      restartWithWatch: boolean,
    ): Promise<boolean> => {
      const stopped = await stopProcessByPidFile(gatewayPidFile, "gateway");
      if (!stopped && isProcessAlive(gatewayPidFile).alive) {
        console.log(
          `Gateway running (pid ${gatewayState.pid}) but could not be stopped.`,
        );
        return false;
      }
      await startGateway(restartWithWatch, entry, {
        bootstrapSecret,
      });
      return true;
    };
    const needsRestart = bootstrapSecretBackfilled && gatewayAlive;
    if (gatewayStuck) {
      console.log(
        `Gateway running (pid ${gatewayState.pid}) but is not responding and could not be stopped.`,
      );
    } else if (needsRestart) {
      const restartWithWatch = watch && isGatewayWatchModeAvailable();
      if (restartWithWatch) {
        console.log(
          `Gateway running (pid ${gatewayState.pid}) — restarting to apply bootstrap secret...`,
        );
      } else {
        console.log(
          `Gateway running (pid ${gatewayState.pid}) — restarting without watch mode to apply bootstrap secret...`,
        );
      }
      gatewayStarted = await restartGateway(restartWithWatch);
    } else if (gatewayAlive) {
      if (watch && isGatewayWatchModeAvailable()) {
        console.log(
          `Gateway running (pid ${gatewayState.pid}) — restarting in watch mode...`,
        );
        gatewayStarted = await restartGateway(watch);
      } else {
        if (watch) {
          console.log(
            `Gateway running (pid ${gatewayState.pid}) — watch mode not available, no source files. Keeping existing process.`,
          );
        } else {
          console.log(`Gateway already running (pid ${gatewayState.pid}).`);
        }
      }
    } else {
      await startGateway(watch, entry, { bootstrapSecret });
      gatewayStarted = true;
    }
  }

  // A freshly-(re)started gateway refuses all non-probe traffic until the
  // daemon reports migration readiness, so consumers that act right after
  // wake (the web connect-repair retry, the guardian re-provision below)
  // would hit its closed gate. When the daemon is migrating AND the gateway
  // was just started (or a guardian repair was requested), wait out the
  // migration — capped at 60s and at whatever budget remains before the
  // 180s host-wrapper SIGTERM (30s headroom kept), since earlier bounded
  // waits may already have consumed most of it. Fast path (gateway already
  // serving, no repair) stays ~1s.
  if (daemonUnready && !daemonMigrationsFailed && gatewayStarted) {
    const waitBudgetMs = Math.min(60_000, wakeStartedAt + 150_000 - Date.now());
    if (waitBudgetMs > 0) {
      const readiness = await waitForDaemonMigrationsReady(
        daemonPort,
        Date.now() + waitBudgetMs,
      );
      daemonUnready = readiness !== "ready";
      daemonMigrationsFailed = readiness === "failed";
    }
  }

  // Restore the nginx edge and point the auto-tunnel at it. The spawned agent
  // records itself in the root lockfile under `tunnel`. Non-fatal: a down
  // edge is a degraded remote-web/webhook path, not a broken assistant.
  await restoreAppServerAndAutoTunnel();

  if (daemonMigrationsFailed) {
    console.log(
      "Assistant database migrations FAILED — DB-backed routes will return 503 until the assistant is restarted. Check the daemon logs.",
    );
  } else if (daemonUnready) {
    console.log(
      "Assistant is still running database migrations; DB-backed routes return 503 until they finish.",
    );
  }
  console.log("Wake complete.");
}

/**
 * Mint (and approve) a remote-web pairing challenge on the local gateway —
 * the `gateway pairing mint` the pair command wraps, run through the
 * gateway CLI invocation. Process execution is the local-presence proof.
 * Returns the command's stdout; its last line is the challenge JSON.
 */
export async function localPair(entry: LocalAssistant): Promise<string> {
  const invocation = gatewayCliInvocation(entry);
  return execOutput(
    invocation.command,
    [...invocation.args, "pairing", "mint"],
    {
      cwd: invocation.cwd,
      env: invocation.env,
      timeoutMs: 30_000,
    },
  );
}
