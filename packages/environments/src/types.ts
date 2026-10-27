/**
 * Environment type definitions. Environments are deployment targets with
 * their own platform backend and their own isolated on-host state. See the
 * "Coexisting environments" design doc for the full model.
 */

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
 * A resolved environment definition. Required fields are `name` and
 * `cloudUrl`. All other fields are optional and declared upfront — new
 * fields are additive, never breaking. `name` is intentionally typed as
 * `string` (not `keyof SEEDS`) so custom environments can be represented by
 * future layers (user config file, ad-hoc env vars, etc.).
 */
export interface EnvironmentDefinition {
  name: string;
  cloudUrl: string;

  /**
   * The web app (Next.js) base URL for browser-facing pages like
   * `/account/login`. In production this is separate from the API backend
   * (e.g. `mycadet.ai` vs `cloud.mycadet.ai`); locally it's
   * `localhost:3000` vs `localhost:8000`.
   *
   * Mirrors `CadetEnvironment.webURL` on the Swift side.
   */
  webUrl: string;

  /**
   * Override for the cloud URL the assistant process itself uses. Only
   * differs from `cloudUrl` when the assistant runs in a different network
   * namespace than the host (e.g. Docker on macOS, where the host's localhost
   * is reached via `host.docker.internal`). Falls back to `cloudUrl` when
   * unset.
   */
  assistantCloudUrl?: string;

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
