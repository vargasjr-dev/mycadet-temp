/**
 * The platform origin this app talks to at runtime: the shell-injected
 * `__CADET_CONFIG__.platformUrl` (Electron preload, CLI) when present,
 * else the page origin (the platform SPA is served from the platform host).
 *
 * Lives in its own leaf module — not `local-mode` — so transport-level
 * consumers (e.g. the live-voice tunnel host derivation) don't pull the whole
 * local-mode graph into theirs.
 */
export function getPlatformRuntimeUrl(): string {
  return window.__CADET_CONFIG__?.platformUrl || window.location.origin;
}
