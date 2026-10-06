/**
 * Dependencies every desktop client's electron-vite config must bundle inline
 * instead of externalizing as runtime `require(...)` calls.
 *
 * - `electron-store` and `conf` are ESM-only: an externalized CJS
 *   `require(...)` returns the module namespace and breaks `new Store(...)`.
 * - `zod` is imported at module scope by `@mycadet/ipc-contract`, which the
 *   preload bundles pull in. The sandboxed preload can only require
 *   `electron`, so one bare external require kills the whole preload script
 *   and `window.vellum` is never exposed (see `preload-externals.ts`).
 * - The `@mycadet/*` workspace packages ship raw TypeScript with no build
 *   step; inlining lets Rollup compile their source into the bundle.
 *
 * Clients import this RELATIVELY (not via the package entry): electron-vite
 * loads configs under Node, which cannot require raw-TS package subpaths.
 */
export const SHARED_DESKTOP_INLINE_DEPS = [
  "electron-log",
  "electron-store",
  "conf",
  "zod",
  "@mycadet/electron-utils",
  "@mycadet/electron-desktop",
  "@mycadet/ipc-contract",
  "@mycadet/local-mode",
  "@mycadet/environments",
];
