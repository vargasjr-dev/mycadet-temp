/**
 * @mycadet/environments: install layout for a Cadet checkout or installed
 * package, plus the shell/path-guard helpers the CLI, assistant, and desktop
 * clients share — and the environment seeds (names, the single base URL per
 * deployment, port blocks) every surface reads. The seeds file is
 * standalone so the Capacitor config loader can consume it through the
 * `./seeds` subpath; everything else rides the index barrel.
 */
export * from "./install-layout.js";
export * from "./seeds.js";
export * from "./shell.js";
export * from "./test-path-guard.js";
