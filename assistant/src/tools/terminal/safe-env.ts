/**
 * Environment variables that are safe to pass through to child processes.
 * Everything else (API keys, tokens, credentials) is stripped to prevent
 * accidental leakage via agent-spawned commands.
 *
 * Shared by the sandbox bash tool and skill sandbox runner.
 */
import { readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, win32 } from "node:path";

import {
  pathListDelimiter,
  prependUniquePathEntries,
} from "@mycadet/environments/shell";

import { getGatewayInternalBaseUrl } from "../../config/env.js";
import { getDataDir, getWorkspaceDir } from "../../util/layout.js";

export const SAFE_ENV_VARS = [
  "PATH",
  "HOME",
  "TERM",
  "LANG",
  "EDITOR",
  "SHELL",
  "USER",
  "TMPDIR",
  "LC_ALL",
  "LC_CTYPE",
  "XDG_RUNTIME_DIR",
  "DISPLAY",
  "COLORTERM",
  "TERM_PROGRAM",
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "GPG_TTY",
  "GNUPGHOME",
  "CADET_DEV",
  "CADET_DEBUG",
  "CADET_SLOW_SYNC_THRESHOLD_MS",
  "CADET_SLOW_QUERY_THRESHOLD_MS",
  "CADET_DEVICE_ID",
  "CADET_ENVIRONMENT",
  "CADET_TEST_LOG_LEVEL",

  "CADET_WORKSPACE_DIR",
  "CES_BOOTSTRAP_SOCKET_DIR",
  "GATEWAY_INTERNAL_URL",
  "ASSISTANT_IPC_SOCKET_DIR",
  "GATEWAY_IPC_SOCKET_DIR",
  "GATEWAY_SECURITY_DIR",
  // The instance's CES-private directory paths (not secret values — the same
  // class as GATEWAY_SECURITY_DIR). A bash-tool child invoking the installed
  // `assistant` command resolves this instance's security dirs from these
  // instead of its cwd fallbacks.
  "CREDENTIAL_SECURITY_DIR",
  "CES_DATA_DIR",
  "CADET_CLOUD_URL",
  "CADET_ASSISTANT_PLATFORM_URL",
  "CADET_DOCS_BASE_URL",
  "CADET_WEB_URL",
  "CADET_MARKETING_URL",
  "CADET_MIGRATION_EXPORT_ALLOWED_HOSTS",
  "CADET_MIGRATION_IMPORT_ALLOWED_HOSTS",
  "CES_MANAGED_MODE",
  "CES_CREDENTIAL_URL",
  "CES_SERVICE_TOKEN",
  // Child processes (bash, skill sandbox, scheduled scripts) reach CES
  // over IPC via `CES_BOOTSTRAP_SOCKET_DIR`. CES HTTP credentials are
  // forwarded so children can fail over to CES HTTP while that transport
  // still exists.
  // Per-instance port of the assistant-managed Qdrant sidecar, so skill and
  // bash-tool subprocesses that use the vector helpers (e.g. embed/search over
  // `@mycadet/plugin-api`) resolve the same local sidecar as the daemon
  // (127.0.0.1:<port>). `QDRANT_URL` is intentionally excluded: it flips
  // QdrantManager into external mode and bypasses the local managed lifecycle.
  "QDRANT_HTTP_PORT",
  "IS_CONTAINERIZED",
  "IS_CLOUD",
  "CADET_CLOUD",
  "CADET_SANDBOX_RUNTIME",
  "CADET_PROFILER_RUN_ID",
  "CADET_PROFILER_MODE",
  "CADET_PROFILER_MAX_BYTES",
  "CADET_PROFILER_MAX_RUNS",
  "CADET_PROFILER_MIN_FREE_MB",
  "CADET_MEMORY_LIMIT",
  "CADET_CPU_LIMIT",
  "CADET_ONNX_INTRA_OP_THREADS",
  "CADET_MINIKUBE_STORAGE_SIZE",
  "CADET_BACKUP_DIR",
  "CADET_BACKUP_KEY_PATH",
  // CADET_PLUGIN_NAME is intentionally absent. The daemon injects the
  // owning plugin install name after sanitizing the child environment.
  // Inheriting a parent-supplied value would let an arbitrary process
  // claim another plugin's credential scope.
] as const;

export const WINDOWS_SAFE_ENV_VARS = [
  "SystemRoot",
  "COMSPEC",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
  "PATHEXT",
  "SystemDrive",
] as const;

export const KATA_SAFE_ENV_VARS = [
  "CADET_APT_DATA_ROOT",
  "CADET_APT_DATA_SUITE",
  "CADET_APT_DATA_MIRROR",
] as const;

export const KATA_INJECTED_ENV_VARS = [
  "LD_LIBRARY_PATH",
  "PYTHONPATH",
  "PYTHONUSERBASE",
  "BUN_INSTALL",
] as const;

const KATA_APT_DATA_ROOT = "/data/system";
const KATA_FAMILY_SANDBOX_RUNTIMES = new Set([
  "kata",
  "firecracker",
  "cloud-hypervisor",
]);

function isKataFamilyRuntime(runtime: string | undefined): boolean {
  return runtime != null && KATA_FAMILY_SANDBOX_RUNTIMES.has(runtime);
}

function kataAptPaths(dataRoot: string): string[] {
  return [
    // Shims for chroot wrapper scripts with hardcoded absolute paths must
    // shadow the broken originals in the chroot bin dirs below (see
    // docker-kata-apt-shims.sh).
    `${dataRoot}/.host-shims`,
    `${dataRoot}/bin`,
    `${dataRoot}/usr/local/sbin`,
    `${dataRoot}/usr/local/bin`,
    `${dataRoot}/usr/sbin`,
    `${dataRoot}/usr/bin`,
    `${dataRoot}/sbin`,
    `${dataRoot}/usr/games`,
    `${dataRoot}/games`,
  ];
}

function kataAptLibraryPaths(dataRoot: string): string[] {
  return [
    `${dataRoot}/usr/local/lib`,
    `${dataRoot}/usr/lib`,
    `${dataRoot}/usr/lib/x86_64-linux-gnu`,
    `${dataRoot}/usr/lib/aarch64-linux-gnu`,
  ];
}

// Python packages installed into the chroot: apt packages land in the
// unversioned dist-packages dir, chroot pip installs in versioned
// /usr/local/lib/python3.X dirs. Versions come from the image's /usr/lib
// (present before any install, so the path works within the same tool call
// that first runs pip) plus the chroot's /usr/local/lib as a fallback for
// any version drift between image and chroot.
function kataPythonPaths(dataRoot: string): string[] {
  const versions = new Set<string>();
  for (const libDir of ["/usr/lib", `${dataRoot}/usr/local/lib`]) {
    try {
      for (const entry of readdirSync(libDir)) {
        if (/^python3\.\d+$/.test(entry)) {
          versions.add(entry);
        }
      }
    } catch {
      // Directory missing (e.g. chroot not bootstrapped yet) — skip.
    }
  }
  // pip's /usr/local dirs must precede the apt dir, mirroring Debian's
  // sys.path order, so a pip-upgraded package wins over an older apt one.
  return [
    ...[...versions].map(
      (version) => `${dataRoot}/usr/local/lib/${version}/dist-packages`,
    ),
    `${dataRoot}/usr/lib/python3/dist-packages`,
  ];
}

// Bun synthesizes a `node` shim directory (<temp>/bun-node-<hash>/, holding
// `node` and `bun` symlinks to itself) and prepends it to PATH whenever it
// starts with no real Node on PATH. That `node` is Bun, which runs a Node CLI
// under different semantics, so it must never shadow a real interpreter in a
// sandbox subprocess. It stays when it is the only `node` there is: on a native
// install (Bun only, no Node) removing it would break every `#!/usr/bin/env
// node` CLI outright.
function bunNodeShimParents(sourceEnv: NodeJS.ProcessEnv): string[] {
  const roots = [
    tmpdir(),
    "/tmp",
    sourceEnv.TMPDIR,
    sourceEnv.TEMP,
    sourceEnv.TMP,
  ];
  return roots
    .filter((root): root is string => Boolean(root))
    .map((root) => root.replace(/[\\/]+$/, ""));
}

function hasNodeExecutable(dir: string): boolean {
  for (const name of ["node", "node.exe"]) {
    try {
      if (statSync(`${dir}/${name}`).isFile()) {
        return true;
      }
    } catch {
      // Entry missing or unreadable: not a Node interpreter we can use.
    }
  }
  return false;
}

function stripBunNodeShimDirs(
  value: string,
  sourceEnv: NodeJS.ProcessEnv,
): string {
  const parents = bunNodeShimParents(sourceEnv);
  const separator = pathListDelimiter();
  const entries = value.split(separator);
  const kept = entries.filter((entry) => {
    const normalized = entry.replace(/[\\/]+$/, "");
    const cut = Math.max(
      normalized.lastIndexOf("/"),
      normalized.lastIndexOf("\\"),
    );
    if (cut < 0) {
      return true;
    }
    return !(
      normalized.slice(cut + 1).startsWith("bun-node-") &&
      parents.includes(normalized.slice(0, cut))
    );
  });
  if (kept.length === entries.length) {
    return value;
  }
  if (!kept.some(hasNodeExecutable)) {
    return value;
  }
  return kept.join(separator);
}

/**
 * Keys that buildSanitizedEnv always injects into the returned env,
 * independent of what is present in process.env.
 */
export const ALWAYS_INJECTED_ENV_VARS = [
  "INTERNAL_GATEWAY_BASE_URL",
  "SPECIES",
  "CADET_DATA_DIR",
  "CADET_WORKSPACE_DIR",
] as const;

function appendUniquePathEntries(
  value: string | undefined,
  entries: readonly string[],
  separator = pathListDelimiter(),
): string {
  const parts = value ? value.split(separator).filter(Boolean) : [];
  for (const entry of entries) {
    if (!parts.includes(entry)) {
      parts.push(entry);
    }
  }
  return parts.join(separator);
}

export function buildSanitizedEnv(
  hostPlatform: NodeJS.Platform = process.platform,
  sourceEnv: NodeJS.ProcessEnv = process.env,
  options?: { execPath?: string },
): Record<string, string> {
  const env: Record<string, string> = {};
  const isKataRuntime = isKataFamilyRuntime(sourceEnv.CADET_SANDBOX_RUNTIME);
  const platformVars =
    hostPlatform === "win32" ? WINDOWS_SAFE_ENV_VARS : ([] as const);
  const safeEnvVars = isKataRuntime
    ? [...SAFE_ENV_VARS, ...platformVars, ...KATA_SAFE_ENV_VARS]
    : [...SAFE_ENV_VARS, ...platformVars];

  const windowsEnv =
    hostPlatform === "win32"
      ? new Map(
          Object.entries(sourceEnv).map(([key, value]) => [
            key.toLowerCase(),
            value,
          ]),
        )
      : null;
  for (const key of safeEnvVars) {
    const value = windowsEnv?.get(key.toLowerCase()) ?? sourceEnv[key];
    if (value != null) {
      env[key] = value;
    }
  }
  if (isKataRuntime) {
    const kataAptDataRoot = env.CADET_APT_DATA_ROOT ?? KATA_APT_DATA_ROOT;
    env.CADET_APT_DATA_ROOT = kataAptDataRoot;
    env.PATH = appendUniquePathEntries(env.PATH, kataAptPaths(kataAptDataRoot));
    env.LD_LIBRARY_PATH = appendUniquePathEntries(
      undefined,
      kataAptLibraryPaths(kataAptDataRoot),
    );
    env.PYTHONPATH = appendUniquePathEntries(
      undefined,
      kataPythonPaths(kataAptDataRoot),
    );
    // The image bakes these under ephemeral /home/assistant; $HOME is the
    // persistent data volume on kata pods, so user-level installs survive
    // machine saves.
    if (env.HOME) {
      env.PYTHONUSERBASE = `${env.HOME}/.python`;
      env.BUN_INSTALL = `${env.HOME}/.bun`;
      env.PATH = appendUniquePathEntries(
        `${env.PYTHONUSERBASE}/bin:${env.BUN_INSTALL}/bin`,
        env.PATH.split(pathListDelimiter()).filter(Boolean),
      );
    }
  }
  // Runs after the kata entries are in place: a Node installed into the
  // persistent apt chroot is what makes dropping Bun's shim safe there.
  if (env.PATH != null) {
    env.PATH = stripBunNodeShimDirs(env.PATH, sourceEnv);
  }
  // Always inject an internal gateway base for local control-plane/API calls.
  const internalGatewayBase = getGatewayInternalBaseUrl();
  env.INTERNAL_GATEWAY_BASE_URL = internalGatewayBase;
  // @deprecated — CADET_DATA_DIR is equivalent to $CADET_WORKSPACE_DIR/data.
  // Removing this requires an LLM-based migration or declarative migration
  // file to update existing user-authored skills to use CADET_WORKSPACE_DIR.
  env.CADET_DATA_DIR = getDataDir();
  // Expose the workspace directory so skills and child processes can read/write
  // workspace-scoped files (e.g. avatar traits, user data).
  env.CADET_WORKSPACE_DIR = getWorkspaceDir();
  // Identify the assistant species so skill scripts can gate on species-specific
  // logic. Hardcoded to "cadet" — this is the Cadet assistant codebase.
  env.SPECIES = "cadet";
  // Ensure UTF-8 locale so multi-byte characters (em dashes, curly quotes,
  // arrows, etc.) survive piping through tools like pbcopy without corruption.
  // macOS (Darwin) does not provide C.UTF-8, so use en_US.UTF-8 there.
  const utf8Locale = process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8";
  if (!env.LANG) {
    env.LANG = utf8Locale;
  }
  if (!env.LC_ALL) {
    env.LC_ALL = utf8Locale;
  }
  // Windows: guarantee the system directories are reachable. The daemon can
  // be spawned with a minimal PATH (app dirs + SystemRoot dirs) that omits
  // `System32\WindowsPowerShell\v1.0` — the directory powershell.exe actually
  // lives in — so bare-name spawns of the Windows shell fail with
  // `Executable not found in $PATH: "powershell.exe"`. Unique-prepend is a
  // no-op for entries already present, so this is safe to always run.
  if (hostPlatform === "win32" && env.SystemRoot) {
    const systemRoot = env.SystemRoot;
    env.PATH = prependUniquePathEntries(
      env.PATH,
      [
        win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0"),
        win32.join(systemRoot, "System32"),
        win32.join(systemRoot, "System32", "Wbem"),
      ],
      hostPlatform,
    );
  }
  prependAssistantDir(env, hostPlatform, options?.execPath ?? process.execPath);
  return env;
}

/** Whether `execPath` is a bun runtime rather than a compiled product binary. */
function isBunRuntime(execPath: string): boolean {
  const base = basename(execPath);
  return base === "bun" || base === "bunx" || base.startsWith("bun-");
}

/**
 * When a compiled `assistant` ships beside this daemon binary (the app
 * bundle's layout), put that directory on the bash tool's PATH: tool-spawned
 * children invoke `assistant …` directly, and the sanitized env above already
 * carries the instance env the binary needs. A bun runtime has no sibling
 * product binary — dev and npm-style installs reach `assistant` through the
 * PATH command the daemon installs at startup.
 */
function prependAssistantDir(
  env: Record<string, string>,
  hostPlatform: NodeJS.Platform,
  execPath: string,
): void {
  if (isBunRuntime(execPath)) {
    return;
  }
  const siblingBinary =
    hostPlatform === "win32" ? "assistant.exe" : "assistant";
  const execDir = dirname(execPath);
  try {
    if (!statSync(join(execDir, siblingBinary)).isFile()) {
      return;
    }
  } catch {
    return;
  }
  env.PATH = prependUniquePathEntries(env.PATH, [execDir], hostPlatform);
}
