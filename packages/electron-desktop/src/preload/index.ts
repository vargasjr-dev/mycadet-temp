/**
 * The package's preload surface — the only exposed preload entry. The
 * bridge factories and the composer both live here so the clients' preload
 * indexes (and their tests) need no other subpath.
 */
export * from "./factories";
export { composeDesktopPreload } from "./compose";
export type { PreloadFeatureInstall } from "./compose";
