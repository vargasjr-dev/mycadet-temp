/**
 * @mycadet/environments: install layout for a Cadet checkout or installed
 * package, plus the shell/path-guard helpers the CLI, assistant, and desktop
 * clients share.
 *
 * The environment seeds (names, the single base URL per deployment, port
 * blocks) used to live here — they moved to `@mycadet/local-mode`'s
 * `environment-seeds.ts` as this package is thinned out toward deletion.
 * What remains is consumed by the CLI, the assistant daemon, and the OS
 * clients; new code should not add surface here.
 */
export * from "./install-layout.js";
export * from "./shell.js";
export * from "./test-path-guard.js";
