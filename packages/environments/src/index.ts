/**
 * @mycadet/environments: install layout for a Cadet checkout or installed
 * package, plus the shell/path-guard helpers the CLI, assistant, and desktop
 * clients share. The environment seeds (names, the single base URL per
 * deployment, port blocks) live in `@mycadet/shared` — standalone so the
 * Capacitor config loader can consume them through its `./seeds` subpath.
 */
export * from "./install-layout.js";
export * from "./shell.js";
export * from "./test-path-guard.js";
