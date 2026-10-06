/**
 * Centralized environment variable registry.
 *
 * This module documents every VELLUM_* and related env var with its type,
 * default, and description, and exports typed accessor functions for each.
 * Every `VELLUM_X` var is read with the rebrand fallback rule: `CADET_X` is
 * primary (wins when set), `VELLUM_X` is the legacy fallback (see readEnv).
 *
 * IMPORTANT: This module has NO internal imports (no logger, no platform
 * utilities) so it can be safely imported from bootstrap-level code like
 * util/platform.ts and util/logger.ts without circular dependencies.
 *
 * Higher-level env vars that depend on the logger or config system live in
 * config/env.ts, which re-exports selected accessors from this module.
 */

// ── Helpers (dependency-free) ────────────────────────────────────────────────

const VELLUM_ENV_PREFIX = "VELLUM_";
const CADET_ENV_PREFIX = "CADET_";

/**
 * Read an env var with the rebrand fallback rule: for every `VELLUM_X` the
 * `CADET_X` spelling is primary — when set it wins; otherwise the legacy
 * `VELLUM_X` value applies. Platform-managed deployments still inject
 * `VELLUM_*` today, so both spellings keep working during the migration.
 * Vars without the `VELLUM_` prefix (e.g. `GATEWAY_PORT`) are read as-is.
 */
export function readEnv(name: string): string | undefined {
  if (name.startsWith(VELLUM_ENV_PREFIX)) {
    const cadetName = CADET_ENV_PREFIX + name.slice(VELLUM_ENV_PREFIX.length);
    const cadetValue = process.env[cadetName]?.trim();
    if (cadetValue) {
      return cadetValue;
    }
  }
  const v = process.env[name]?.trim();
  return v || undefined;
}

function str(name: string): string | undefined {
  return readEnv(name);
}

function flag(name: string): boolean {
  const raw = str(name);
  return raw === "true" || raw === "1";
}

function int(name: string): number | undefined {
  const raw = str(name);
  if (raw === undefined) {
    return undefined;
  }
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}

// ── Registry ─────────────────────────────────────────────────────────────────
// Each entry documents the env var name, type, default, and purpose.

/**
 * DEBUG_STDOUT_LOGS — boolean, default: false
 * Enables additional log output to stdout (alongside file logging).
 */
export function getDebugStdoutLogs(): boolean {
  return flag("DEBUG_STDOUT_LOGS");
}

/**
 * IS_CONTAINERIZED — boolean, default: false
 * When true, indicates the assistant is running inside a container (e.g. Docker).
 * Persistent data is stored in VELLUM_WORKSPACE_DIR (mapped to a dedicated volume).
 */
export function getIsContainerized(): boolean {
  return flag("IS_CONTAINERIZED");
}

/**
 * IS_PLATFORM — boolean, default: false
 * When true, indicates the assistant is running as a platform-managed
 * remote instance. Controls platform-specific behaviors like webhook
 * callback registration and blocking `platform disconnect`.
 *
 * Separate from IS_CONTAINERIZED because local Docker assistants are
 * containerized (need CES sidecar, gateway trust store, etc.) but are
 * not platform-managed.
 */
export function getIsPlatform(): boolean {
  return flag("IS_PLATFORM");
}

/**
 * Whether this assistant is running as a platform-managed remote instance.
 */
export function isPlatformRemote(): boolean {
  return getIsPlatform();
}

/**
 * VELLUM_DISABLE_PLATFORM — boolean, default: false
 * When true, all outbound platform API calls in local mode are suppressed.
 * The daemon, gateway, and web UI each no-op platform requests with a
 * debug log. Has no effect when IS_PLATFORM is true (platform-managed
 * instances always connect to the platform).
 */
export function getDisablePlatform(): boolean {
  return flag("VELLUM_DISABLE_PLATFORM");
}

/**
 * VELLUM_DEVICE_ID — string, default: undefined
 * Host-stable device id injected by the CLI into containerized deployments,
 * where the container fs cannot persist device.json across recreation.
 * Takes precedence over device.json resolution in util/device-id.ts.
 */
export function getDeviceIdOverride(): string | undefined {
  return str("VELLUM_DEVICE_ID");
}

/**
 * VELLUM_WORKSPACE_DIR — string, default: undefined
 * Overrides the default workspace directory.
 * Used in containerized deployments where the workspace is a separate volume.
 */
export function getWorkspaceDirOverride(): string | undefined {
  return str("VELLUM_WORKSPACE_DIR");
}

/**
 * VELLUM_BACKUP_DIR — string, default: undefined
 * Overrides the default backup root directory (~/.vellum/backups/).
 * Used in containerized deployments where the backup directory must be
 * on a persistent volume.
 */
export function getBackupDirOverride(): string | undefined {
  return str("VELLUM_BACKUP_DIR");
}

/**
 * VELLUM_BACKUP_KEY_PATH — string, default: undefined
 * Overrides the default backup encryption key path (~/.vellum/protected/backup.key).
 * Used in containerized deployments where the key must be on a persistent volume.
 */
export function getBackupKeyPathOverride(): string | undefined {
  return str("VELLUM_BACKUP_KEY_PATH");
}

// ── Profiler env vars ───────────────────────────────────────────────────
// These are injected by the platform when running a managed assistant in
// profiler mode. The runtime uses them to locate, scope, and budget-limit
// profiler output on the workspace volume.

/**
 * VELLUM_CPU_LIMIT — string (K8s resource format), default: undefined
 * The CPU resource limit for the container (e.g. "2000m", "2").
 * Set by the platform StatefulSet template to the exact K8s CPU limit.
 * Used by the health endpoint to report accurate CPU core count inside
 * gVisor sandboxes where cgroup files may expose the host node's CPUs.
 */
export function getCpuLimit(): string | undefined {
  return str("VELLUM_CPU_LIMIT");
}

/**
 * VELLUM_MINIKUBE_STORAGE_SIZE — string (K8s resource format), default: undefined
 * The PVC storage request size for the assistant volume (e.g. "10Gi").
 * Only set in minikube (local dev) mode. Used by the health endpoint to
 * report accurate disk capacity on hostPath-backed PVCs where statfsSync
 * reports the host's entire filesystem instead of the PVC.
 */
export function getMinikubeStorageSize(): string | undefined {
  return str("VELLUM_MINIKUBE_STORAGE_SIZE");
}

/**
 * VELLUM_PROFILER_RUN_ID — string, default: undefined
 * Unique identifier for the current profiler run. When set, the profiler
 * run store treats this run as "active" and will never prune its directory.
 */
export function getProfilerRunId(): string | undefined {
  return str("VELLUM_PROFILER_RUN_ID");
}

/**
 * VELLUM_PROFILER_MODE — string, default: undefined
 * The profiling mode to activate (e.g. "cpu", "heap", "cpu+heap").
 * When unset, profiling is disabled.
 */
export function getProfilerMode(): string | undefined {
  return str("VELLUM_PROFILER_MODE");
}

/**
 * VELLUM_PROFILER_MAX_BYTES — integer, default: undefined
 * Maximum total bytes retained across all profiler runs (including active).
 * The startup sweep prunes oldest completed runs to stay within budget.
 */
export function getProfilerMaxBytes(): number | undefined {
  return int("VELLUM_PROFILER_MAX_BYTES");
}

/**
 * VELLUM_PROFILER_MAX_RUNS — integer, default: undefined
 * Maximum number of completed profiler runs retained on disk.
 * The startup sweep prunes oldest completed runs to stay within budget.
 */
export function getProfilerMaxRuns(): number | undefined {
  return int("VELLUM_PROFILER_MAX_RUNS");
}

/**
 * VELLUM_PROFILER_MIN_FREE_MB — integer, default: undefined
 * Minimum free disk space (in megabytes) that must remain after profiler
 * runs are accounted for. The startup sweep prunes oldest completed runs
 * until at least this much free space is available.
 */
export function getProfilerMinFreeMb(): number | undefined {
  return int("VELLUM_PROFILER_MIN_FREE_MB");
}

// ── Known env var names ──────────────────────────────────────────────────────

/**
 * Complete set of recognized VELLUM_* env var names. Used by validateEnvVars()
 * to warn about typos or unrecognized variables.
 */
const KNOWN_VELLUM_VARS = new Set([
  "VELLUM_ASSISTANT_NAME",
  "VELLUM_ASSISTANT_PLATFORM_URL",
  "VELLUM_AWS_ROLE_ARN",
  "VELLUM_BACKUP_DIR",
  "VELLUM_BACKUP_KEY_PATH",
  "VELLUM_CLOUD",
  "VELLUM_DAEMON_AUTOSTART",
  "VELLUM_DATA_DIR",
  "VELLUM_DEBUG",
  "VELLUM_DESKTOP_APP",
  "VELLUM_DEV",
  "VELLUM_DEVICE_ID",
  "VELLUM_DISABLE_PLATFORM",
  "VELLUM_DOCS_BASE_URL",
  "VELLUM_ENVIRONMENT",
  "VELLUM_HATCHED_BY",
  "VELLUM_HOOK_EVENT",
  "VELLUM_HOOK_NAME",
  "VELLUM_HOOK_SETTINGS",
  "VELLUM_LOCKFILE_DIR",
  "VELLUM_MARKETING_URL",
  "VELLUM_MIGRATION_EXPORT_ALLOWED_HOSTS",
  "VELLUM_MIGRATION_IMPORT_ALLOWED_HOSTS",
  "VELLUM_PLATFORM_URL",
  "VELLUM_PROFILER_MAX_BYTES",
  "VELLUM_PROFILER_MAX_RUNS",
  "VELLUM_PROFILER_MIN_FREE_MB",
  "VELLUM_PROFILER_MODE",
  "VELLUM_PROFILER_RUN_ID",
  "VELLUM_ROOT_DIR",
  "VELLUM_SSH_USER",
  "VELLUM_WEB_URL",
  "VELLUM_WORKSPACE_DIR",
  "VELLUM_CPU_LIMIT",
  "VELLUM_MEMORY_LIMIT",
  "VELLUM_MINIKUBE_STORAGE_SIZE",
  "VELLUM_ONNX_INTRA_OP_THREADS",
]);

/**
 * Check all VELLUM_* env vars and return warnings for any unrecognized ones.
 * Returns an array of warning messages (empty if all vars are recognized).
 *
 * This is intentionally a pure function that returns strings rather than
 * logging directly, so it can be called from bootstrap code before the
 * logger is initialized.
 */
/**
 * A var is recognized when it is a known `VELLUM_*` var, or the `CADET_*`
 * spelling of one (the rebrand fallback rule — see `readEnv`).
 */
function isRecognizedEnvVar(key: string): boolean {
  if (KNOWN_VELLUM_VARS.has(key)) {
    return true;
  }
  if (key.startsWith(CADET_ENV_PREFIX)) {
    return KNOWN_VELLUM_VARS.has(
      VELLUM_ENV_PREFIX + key.slice(CADET_ENV_PREFIX.length),
    );
  }
  return false;
}

export function checkUnrecognizedEnvVars(): string[] {
  const warnings: string[] = [];
  for (const key of Object.keys(process.env)) {
    if (isRecognizedEnvVar(key)) {
      continue;
    }
    if (key.startsWith("VELLUM_") || key.startsWith("CADET_")) {
      warnings.push(`Unrecognized environment variable: ${key}`);
    }
  }
  return warnings;
}
