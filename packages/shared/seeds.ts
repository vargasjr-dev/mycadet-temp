// Loaded standalone by Capacitor's single-file TS config loader (via the
// `./seeds` subpath) — keep imports type-only (this file has none) and keep
// this file free of the import-meta meta-property: the loader transpiles this
// file to CJS, where that syntax is illegal and makes Node misroute the
// result as ESM. Browser bundles (chrome extension, web renderer) import it
// for the same reason.

/**
 * Per-service default port set. Phase 5 (per-environment port offsets) is
 * deferred from MVP, so today every environment uses the same port set. The
 * shape exists so the rest of the stack can call `getDefaultPorts(env)` and
 * gain per-env offsets later without changing any call sites.
 */
export interface PortMap {
  daemon: number;
  gateway: number;
  qdrant: number;
  ces: number;
  outboundProxy: number;
  tcp: number;
}

/**
 * The port the local app server binds by default — the single origin every
 * local surface (webview, assistant daemon, CLI) dials. The local seed's
 * base URL reuses it so no surface carries its own port constant.
 */
export const DEFAULT_APP_SERVER_PORT = 7840;

/**
 * A resolved environment definition. Required fields are `name` and
 * `baseUrl`. All other fields are optional and declared upfront — new
 * fields are additive, never breaking. `name` is a `CadetEnvironment`: a
 * definition outside the known names has nowhere to key into.
 */
export interface EnvironmentDefinition {
  name: CadetEnvironment;

  /**
   * The single origin for API, auth, web, and the assistant mount — one
   * deployment serves all of it, so one URL describes it. The local seed
   * points at the app server's default port; the cloud seeds point at the
   * environment's host.
   */
  baseUrl: string;

  /** Human-readable label for UI surfaces. */
  displayName?: string;

  /** Hint for UI surfaces that want to tint or badge their display. */
  tintColor?: string;

  /** Per-service port overrides merged on top of defaults. */
  portsOverride?: Partial<PortMap>;

  /** Override for the XDG config directory. */
  configDirOverride?: string;

  /**
   * Override for the directory containing the lockfile. In-memory only —
   * tests inject curated env lists with it; path helpers never read env
   * vars to populate it.
   */
  lockfileDirOverride?: string;
}

/**
 * Non-prod port blocks. Each environment gets a 1000-port window in the
 * 17000–21000 band. Within a block, services are spaced 100 apart so up to
 * 100 assistants can coexist without the scan (`findAvailablePort`) running
 * one service's range into the next. Band chosen to sit below Linux's
 * default ephemeral start (32768) and macOS's (49152), and away from the
 * 3000/5000/8000/9000 dev-tool swamp. Production keeps its legacy,
 * non-contiguous port set (7821/7830/6333/8090/8080/8765): cross-env
 * collision is the only problem this change targets, prod is unaffected
 * because only one env's assistants compete on a given machine, and
 * churning it would leave existing hatches on 7821 while new ones
 * allocated elsewhere.
 */
function portBlock(base: number): PortMap {
  return {
    daemon: base,
    gateway: base + 100,
    qdrant: base + 200,
    ces: base + 300,
    outboundProxy: base + 400,
    tcp: base + 500,
  };
}

/**
 * The set of environment names every surface shares — the seeds below are
 * exactly these five. Lockfiles, config directories, release channels, and
 * the mobile shells' scheme keys all key off this union, so a name outside
 * it is a bug the compiler can catch.
 */
export const CADET_ENVIRONMENT_NAMES = [
  "local",
  "dev",
  "staging",
  "production",
  "test",
] as const;

export type CadetEnvironment = (typeof CADET_ENVIRONMENT_NAMES)[number];

function isCadetEnvironment(
  name: string | undefined,
): name is CadetEnvironment {
  return (
    typeof name === "string" &&
    (CADET_ENVIRONMENT_NAMES as readonly string[]).includes(name)
  );
}

/**
 * globalThis.process reads the same env under bun/node while staying
 * crash-free in browser bundles (no bare `process` reference) — and free
 * of import-meta syntax, which the Capacitor config loader can't transpile.
 */
function processEnv(): Record<string, string | undefined> | undefined {
  return (
    globalThis as unknown as {
      process?: { env?: Record<string, string | undefined> };
    }
  ).process?.env;
}

/**
 * Whether a version string denotes a dev build from the dev-release
 * pipeline, e.g. `0.12.6-dev.202610081023.3a27b77`.
 */
export function isDevVersion(version: string): boolean {
  return /-dev\./i.test(version);
}

/**
 * Whether a version string denotes a staging build, e.g. `0.6.0-staging.3`.
 */
export function isStagingVersion(version: string): boolean {
  return /-staging\./i.test(version);
}

/**
 * Whether a version string denotes a local build, e.g. `0.12.6-local.42`.
 * Local builds are never published.
 */
export function isLocalVersion(version: string): boolean {
  return /-local\./i.test(version);
}

/**
 * The environment a released channel version pins, or `undefined` when the
 * version carries no channel suffix. A plain version — a workspace
 * checkout's unstamped package version — reads as "no version signal",
 * leaving the remaining steps to decide. Mirrors the CLI resolver's mapping
 * (local, dev, staging).
 */
export function environmentFromVersion(
  version: string | undefined,
): CadetEnvironment | undefined {
  if (isLocalVersion(version ?? "")) return "local";
  if (isDevVersion(version ?? "")) return "dev";
  if (isStagingVersion(version ?? "")) return "staging";
  return undefined;
}

/**
 * Read the persisted default environment — the file pre-version-tied CLIs
 * wrote so their successors honor the machine's chosen default. Node-only
 * and resolved at call time (`process.getBuiltinModule`), so this file
 * keeps zero static node imports: the Capacitor config loader transpiles it
 * standalone and a static node import would die there, while browser
 * bundles (chrome extension, web renderer) never reach the call.
 */
function readPersistedDefault(): CadetEnvironment | undefined {
  const node = process as unknown as {
    getBuiltinModule?: (id: string) => unknown;
    platform: string;
  };
  const fs = node.getBuiltinModule?.("node:fs") as
    | typeof import("node:fs")
    | undefined;
  const os = node.getBuiltinModule?.("node:os") as
    | typeof import("node:os")
    | undefined;
  const path = node.getBuiltinModule?.("node:path") as
    | typeof import("node:path")
    | undefined;
  if (!fs || !os || !path) return undefined;

  // Mirrors local-mode's resolveConfigHome (the same XDG/AppData derivation).
  const isWindows = node.platform === "win32";
  const join = isWindows ? path.win32.join : path.posix.join;
  const configHome = isWindows
    ? process.env.APPDATA?.trim() || join(os.homedir(), "AppData", "Roaming")
    : process.env.XDG_CONFIG_HOME?.trim() || join(os.homedir(), ".config");
  const filePath = join(configHome, "cadet", "environment");
  try {
    if (!fs.existsSync(filePath)) return undefined;
    const content = fs.readFileSync(filePath, "utf-8").trim();
    return isCadetEnvironment(content) ? content : undefined;
  } catch {
    // Unreadable file — no default.
    return undefined;
  }
}

/**
 * The environment name every surface shares — the single resolution chain
 * local-mode hosts and the mobile config loader both ride:
 *
 *   1. `CADET_ENVIRONMENT` (explicit override, also inherited by the
 *      hatch/retire child processes the CLI spawns), then
 *      `VITE_ENVIRONMENT` (the build-time inlined var bundled surfaces bake)
 *   2. the release channel the running copy's version carries —
 *      `__CADET_OWN_VERSION__`, which the entrypoints that know their
 *      package root inject (the CLI's bin computes its git/local stamp,
 *      the Electron builds define it at build time). A released `-dev.`
 *      install resolves `dev` even on a machine that never wrote a
 *      persisted default
 *   3. the persisted default written by pre-version-tied CLIs (old files
 *      are still honored)
 *   4. `production`
 *
 * The version step is what keeps every released install from silently
 * reading production's state: the channel is decided by the release
 * pipeline, not by whatever default an older CLI happened to leave behind.
 * Names outside `CadetEnvironment` are ignored rather than returned: an
 * unrecognized value falls through to the next arm instead of leaking an
 * unkeyable string into `SEEDS` lookups.
 */
export function resolveEnvironmentName(): CadetEnvironment {
  const env = processEnv();
  const named = [
    env?.CADET_ENVIRONMENT?.trim(),
    env?.VITE_ENVIRONMENT?.trim(),
  ].find(isCadetEnvironment);
  if (named) return named;
  return (
    environmentFromVersion(
      (globalThis as { __CADET_OWN_VERSION__?: string }).__CADET_OWN_VERSION__,
    ) ??
    readPersistedDefault() ??
    "production"
  );
}

/**
 * The base URL of Cadet Cloud — the hosted deployment the local surfaces
 * pair with (API, auth, web, and the assistant mount all live on it). The
 * explicit `CADET_CLOUD_URL` override wins, else the seed of
 * `resolveEnvironmentName`. This says "cloud" because the URL always points
 * at a Cadet Cloud deployment, never at something that represents this
 * surface itself.
 */
export function getCloudBaseUrl(): string {
  const explicit = processEnv()?.CADET_CLOUD_URL?.trim();
  if (explicit) return explicit;
  return SEEDS[resolveEnvironmentName()].baseUrl;
}

/**
 * Built-in environment definitions and the source of truth for the
 * set of known environment names.
 *
 * Custom environments via a user config file are a future phase — see the
 * "Coexisting environments" design doc. Until then, a call site that needs a
 * new environment must add it here and rebuild.
 */
export const SEEDS: Record<CadetEnvironment, EnvironmentDefinition> = {
  production: {
    name: "production",
    baseUrl: "https://mycadet.ai",
  },
  staging: {
    name: "staging",
    baseUrl: "https://staging.mycadet.ai",
    portsOverride: portBlock(17000),
  },
  test: {
    name: "test",
    baseUrl: "https://test.mycadet.ai",
    portsOverride: portBlock(19000),
  },
  dev: {
    name: "dev",
    baseUrl: "https://dev.mycadet.ai",
    portsOverride: portBlock(18000),
  },
  local: {
    name: "local",
    baseUrl: `http://localhost:${DEFAULT_APP_SERVER_PORT}`,
    // assistantBaseUrl: "http://host.docker.internal:7840",
    // ^ uncomment once dockerized hatch path is live — the assistant runs
    // in a different network namespace than the host.
    portsOverride: portBlock(20000),
  },
};
