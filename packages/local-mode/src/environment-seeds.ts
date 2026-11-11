// Loaded standalone by Capacitor's single-file TS config loader — keep
// imports type-only (this file has none) and keep this file free of the
// import-meta meta-property: the loader transpiles this file to CJS, where
// that syntax is illegal and makes Node misroute the result as ESM.

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
 * fields are additive, never breaking. `name` is intentionally typed as
 * `string` (not `keyof SEEDS`) so custom environments can be represented by
 * future layers (user config file, ad-hoc env vars, etc.).
 */
export interface EnvironmentDefinition {
  name: string;

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

/** The single origin for the current environment (CADET_ENVIRONMENT or VITE_ENVIRONMENT; unknown falls back to dev). */
export function environmentBaseUrl(): string {
  // globalThis.process reads the same env under bun/node while staying
  // crash-free in browser bundles (no bare `process` reference) — and free
  // of import-meta syntax, which the Capacitor config loader can't transpile.
  const env = (
    globalThis as unknown as {
      process?: { env?: Record<string, string | undefined> };
    }
  ).process?.env;
  const envName = env?.CADET_ENVIRONMENT ?? env?.VITE_ENVIRONMENT;
  const seed = (envName && SEEDS[envName]) || SEEDS.dev;
  return seed.baseUrl;
}

/**
 * Built-in environment definitions and the source of truth for the
 * set of known environment names.
 *
 * Custom environments via a user config file are a future phase — see the
 * "Coexisting environments" design doc. Until then, a call site that needs a
 * new environment must add it here and rebuild.
 */
export const SEEDS: Record<string, EnvironmentDefinition> = {
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
