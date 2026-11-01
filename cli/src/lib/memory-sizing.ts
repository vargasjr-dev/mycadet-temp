/**
 * Assistant container memory sizing for local Docker launches.
 *
 * By default the assistant container runs with no memory limit (docker's
 * behavior when `--memory` is omitted): the kernel's page cache fills the
 * Docker VM and reclaim only happens when the VM itself runs out — the
 * expensive, whole-VM kind. Cadets are page-cache-hungry workloads (bun
 * re-reads hundreds of modules per test run, git operations, tooling), so
 * the recommended profile starts eviction *early and smoothly* with a soft
 * limit and keeps a hard cap as a backstop:
 *
 * - `--memory-reservation` (cgroup v2 `memory.high`) at 75% of the Docker
 *   VM's total — page-cache eviction begins here, long before anything hurts.
 * - `--memory` (cgroup v2 `memory.max`) at 90% — a backstop so a genuine
 *   leak cannot OOM the VM.
 * - `--memory-swap` equal to `--memory` (no swap allowance): the Docker VM
 *   usually has no swap provisioned anyway, and on hosts that do, the
 *   docker default (2× `--memory`) would silently double the envelope.
 *
 * Sizing is opt-in (the default leaves today's behavior untouched) and is
 * tuned by the guardian through environment variables read at container
 * start:
 *
 * - `CADET_DOCKER_MEMORY_PROFILE=recommended` — apply the 75/90 profile.
 * - `CADET_DOCKER_MEMORY_MAX` / `CADET_DOCKER_MEMORY_HIGH` — explicit
 *   overrides in K8s resource format (`12Gi`, `512Mi`, `750M`, bare bytes).
 *   They activate sizing on their own and take precedence over the profile;
 *   the invariant `high ≤ max` is maintained by clamping.
 *
 * Sizing is proportional to the Docker daemon's total memory (the VM — the
 * resource the container actually shares), not the host's physical RAM.
 */

const RECOMMENDED_HIGH_FRACTION = 0.75;
const RECOMMENDED_MAX_FRACTION = 0.9;

/** Env var that toggles the built-in sizing profile. */
export const MEMORY_PROFILE_ENV_VAR = "CADET_DOCKER_MEMORY_PROFILE";
/** Env var overriding the hard cap (`--memory`). K8s resource format. */
export const MEMORY_MAX_ENV_VAR = "CADET_DOCKER_MEMORY_MAX";
/** Env var overriding the soft limit (`--memory-reservation`). K8s resource format. */
export const MEMORY_HIGH_ENV_VAR = "CADET_DOCKER_MEMORY_HIGH";

export interface AssistantMemorySettings {
  /** Hard cap in bytes → `--memory` (cgroup v2 `memory.max`). */
  maxBytes: number;
  /** Soft limit in bytes → `--memory-reservation` (cgroup v2 `memory.high`). */
  highBytes: number;
}

/** Multipliers for the K8s resource-format suffixes parseMemoryOverride accepts. */
const MEMORY_SUFFIX_MULTIPLIERS: Record<string, number> = {
  K: 1e3,
  KI: 1024,
  M: 1e6,
  MI: 1024 ** 2,
  G: 1e9,
  GI: 1024 ** 3,
  T: 1e12,
  TI: 1024 ** 4,
};

/**
 * Parse a K8s resource-format memory string (`12Gi`, `512Mi`, `750M`,
 * `1024`) into bytes. Binary suffixes (Ki/Mi/Gi/Ti) and decimal suffixes
 * (K/M/G/T) are supported; a bare number is bytes. Throws on anything else
 * so a typo'd override fails the launch loudly instead of silently
 * shrinking to the wrong size.
 */
export function parseMemoryOverride(raw: string): number {
  const match = raw.trim().match(/^(\d+(?:\.\d+)?)\s*([KMGT]i?)?$/i);
  if (!match) {
    throw new Error(
      `${raw} is not a valid memory value (expected K8s resource format like 12Gi, 512Mi, or bare bytes)`,
    );
  }
  const value = Number.parseFloat(match[1]);
  const suffix = match[2]?.toUpperCase();
  const multiplier =
    suffix === undefined ? 1 : MEMORY_SUFFIX_MULTIPLIERS[suffix];
  if (multiplier === undefined) {
    throw new Error(
      `${raw} is not a valid memory value (expected K8s resource format like 12Gi, 512Mi, or bare bytes)`,
    );
  }
  return Math.floor(value * multiplier);
}

/**
 * Resolve the assistant container's memory settings from the guardian's
 * environment. Returns `null` when nothing is set — the default, which
 * leaves the container unlimited (docker's behavior when no `--memory` is
 * passed) exactly as before this module existed.
 *
 * `daemonTotalBytes` is the Docker daemon's total memory (the VM's), the
 * basis the fractions apply to. It may be null when sizing was not
 * requested; an explicitly requested profile without a readable daemon
 * total is an error, not a silent no-op.
 */
export function resolveAssistantMemorySettings(
  env: Record<string, string | undefined>,
  daemonTotalBytes: number | null,
): AssistantMemorySettings | null {
  const profile = env[MEMORY_PROFILE_ENV_VAR];
  const maxRaw = env[MEMORY_MAX_ENV_VAR];
  const highRaw = env[MEMORY_HIGH_ENV_VAR];

  if (!profile && !maxRaw && !highRaw) {
    return null;
  }

  if (profile !== undefined && profile !== "recommended") {
    throw new Error(
      `${MEMORY_PROFILE_ENV_VAR}=${profile} is not a recognized profile (supported: recommended)`,
    );
  }

  if (daemonTotalBytes === null || daemonTotalBytes <= 0) {
    throw new Error(
      "memory sizing was requested but the Docker daemon's total memory could not be read",
    );
  }

  const maxOverride = maxRaw ? parseMemoryOverride(maxRaw) : null;
  const highOverride = highRaw ? parseMemoryOverride(highRaw) : null;

  // Explicit values always win: an explicit MAX is never silently raised, so
  // a HIGH above it clamps down instead; an explicit HIGH above the default
  // cap raises the cap (a reservation at/above the limit is rejected by
  // docker, and silently shrinking the guardian's HIGH would hide the intent).
  const maxBytes =
    maxOverride ??
    Math.max(
      highOverride ?? 0,
      Math.floor(daemonTotalBytes * RECOMMENDED_MAX_FRACTION),
    );
  const defaultHigh = Math.floor(daemonTotalBytes * RECOMMENDED_HIGH_FRACTION);
  const highBytes = Math.min(highOverride ?? defaultHigh, maxBytes);

  return { maxBytes, highBytes };
}

/**
 * The `docker run` flag block for the resolved settings. Empty when sizing
 * is off — the assistant container then runs unlimited, as it always has.
 */
export function assistantMemoryRunArgs(
  settings: AssistantMemorySettings | null,
): string[] {
  if (!settings) {
    return [];
  }
  return [
    "--memory",
    String(settings.maxBytes),
    "--memory-reservation",
    String(settings.highBytes),
    "--memory-swap",
    String(settings.maxBytes),
  ];
}
