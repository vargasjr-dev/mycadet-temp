import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { defineConfig, externalizeDepsPlugin } from "electron-vite";

import { SHARED_DESKTOP_INLINE_DEPS } from "../../packages/electron-desktop/src/inline-deps";

// Build-time reuse of the CLI's version stamper: the local (dev) build bakes
// the exact string `cadet-local --version` prints, so the About panel and the
// injected config agree with the CLI (see resolveCliDisplayVersion below).
import { displayVersion } from "../../cli/src/lib/local-version";

// Reference: https://electron-vite.org/config/
//
// No renderer config: the MAIN window renders the @mycadet/app standalone
// bundle over the custom `app://` protocol in every build — `bun run dev`
// packs the same dists from the source trees and serves them through the
// same handler (see clients/README.md). The auxiliary windows still render
// web routes off clients/web's build.
//
// Dependencies that must be bundled inline rather than externalized as
// runtime `require(...)` calls. The cross-client rules (and the sandboxed
// preload rationale) live in the shared list; only macOS-specific deps are
// added here. Guarded by scripts/preload-externals.test.ts.
const DEPS_TO_INLINE = [
  ...SHARED_DESKTOP_INLINE_DEPS,
  "electron-updater",
  "@mycadet/native-sidecar",
];

// Resolved at config-evaluation time and inlined into the main bundle via
// Vite's `define`. Prefer the CI-provided GITHUB_SHA (7-char prefix);
// fall back to `git rev-parse --short HEAD` on a developer checkout; emit
// "unknown" when neither is available (e.g. building from a tarball).
const resolveBuildSha = (): string => {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 7);
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
};

// Bun version bundled with the app, read from the repo-root `.tool-versions`
// (the same source fetch-bun.sh downloads from). Baked into the main bundle so
// the CLI installer can stamp `packageManager: bun@<version>` on the install it
// writes, marking that install bun-only.
const resolveBunVersion = (): string => {
  try {
    const toolVersions = readFileSync(
      path.resolve(__dirname, "../../.tool-versions"),
      "utf8",
    );
    return toolVersions.match(/^bun\s+(\S+)/m)?.[1] ?? "";
  } catch {
    return "";
  }
};

// Local builds drive the repo CLI source directly instead of installing the
// published package; release builds bake an empty path and keep the pinned
// npm install (see getLocalCliEntry in src/main/cli-installer.ts).
const LOCAL_CLI_ENTRY =
  (process.env.CADET_ENVIRONMENT || "local") === "local"
    ? path.resolve(__dirname, "../../cli/src/index.ts")
    : "";

// The version the About panel + injected config report for local builds:
// the repo CLI's display version — the exact string `cadet-local --version`
// prints (`<base>-local.<stamp>.<sha>`, see cli/src/lib/local-version.ts).
// Release builds bake "" and fall back to the packaged app version the
// release pipeline stamps.
const resolveCliDisplayVersion = (): string => {
  if ((process.env.CADET_ENVIRONMENT || "local") !== "local") return "";
  try {
    const pkg = JSON.parse(
      readFileSync(path.resolve(__dirname, "../../cli/package.json"), "utf8"),
    ) as { version?: string };
    if (!pkg.version) return "";
    return displayVersion(pkg.version);
  } catch {
    return "";
  }
};

const BUILD_DEFINES = {
  __CADET_BUILD_SHA__: JSON.stringify(resolveBuildSha()),
  __CADET_ENVIRONMENT__: JSON.stringify(
    process.env.CADET_ENVIRONMENT || "local",
  ),
  __CADET_LOCAL_CLI_ENTRY__: JSON.stringify(LOCAL_CLI_ENTRY),
  __CADET_VERSION_DISPLAY__: JSON.stringify(resolveCliDisplayVersion()),
  __CADET_BUN_VERSION__: JSON.stringify(resolveBunVersion()),
  __CADET_ENABLE_CHROME_DEVTOOLS__: JSON.stringify(
    process.env.CADET_ENABLE_CHROME_DEVTOOLS === "true" ||
      process.env.CADET_ENABLE_CHROME_DEVTOOLS === "1",
  ),
  // Root hostname (leading dot) shared with the web bundle's
  // VITE_ROOT_HOSTNAME; baked into the CSP source lists (see src/main/csp.ts).
  __CADET_ROOT_HOSTNAME__: JSON.stringify(
    process.env.VITE_ROOT_HOSTNAME || ".mycadet.ai",
  ),
};

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: DEPS_TO_INLINE })],
    define: BUILD_DEFINES,
    build: {
      outDir: "out/main",
      lib: {
        entry: "src/main/index.ts",
      },
      rollupOptions: {
        external: ["electron"],
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: DEPS_TO_INLINE })],
    build: {
      outDir: "out/preload",
      lib: {
        entry: "src/preload/index.ts",
      },
      rollupOptions: {
        external: ["electron"],
      },
    },
  },
});
