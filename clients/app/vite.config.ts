import path from "node:path";
import { appPackage, packageDependencies } from "./vite/app-package";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { injectCloudSessionToken } from "./vite/cloud-proxy";
import {
  localModePlugin,
  getDevCloudSessionToken,
} from "./vite-plugin-local-mode";

const APP_SRC = path.resolve(import.meta.dirname, "src");
const WEB_SRC = path.resolve(import.meta.dirname, "../web/src");
const DESIGN_SRC = path.resolve(
  import.meta.dirname,
  "../../packages/design-library/src",
);

export default defineConfig(({ mode, command }) => {
  // The app package target builds the publishable library, the capacitor
  // target builds the baked mobile boot shell, and everything else is the
  // standalone SPA the edges serve.
  const target =
    process.env.APP_BUILD_TARGET === "package"
      ? "package"
      : process.env.APP_BUILD_TARGET === "capacitor"
        ? "capacitor"
        : "standalone";
  const library = target === "package";
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  Object.assign(env, loadEnv(mode, import.meta.dirname, ""));
  const platform = env.API_PROXY_TARGET || "http://localhost:8000";
  return {
    base: library ? "./" : "/",
    define: {
      __INCLUDES_ACCOUNT__: "false",
      ...(library
        ? { "process.env.NODE_ENV": JSON.stringify("production") }
        : {}),
    },
    plugins: [
      tailwindcss(),
      react(),
      // The boot bundle's config comes from the `build:capacitor` stamp, not
      // the local-mode shim — a second injected `__CADET_CONFIG__` here would
      // race the stamp on read order.
      ...(library
        ? [appPackage()]
        : target === "capacitor"
          ? []
          : [localModePlugin(env)]),
    ],
    // The app owns its public assets (favicon, the signup media) — the
    // standalone bundle must be self-contained so a published @mycadet/app
    // package carries everything the edge-served shell needs. The boot
    // bundle ships inside the IPA/APK, so it carries none of that: the
    // signup media alone would add megabytes a splash never loads.
    publicDir: target !== "capacitor",
    resolve: {
      alias: [
        ...(command === "serve"
          ? [
              {
                find: "@mycadet/app/contracts",
                replacement: path.resolve(APP_SRC, "contracts.ts"),
              },
              {
                find: "@mycadet/app",
                replacement: path.resolve(APP_SRC, "index.ts"),
              },
            ]
          : []),
        { find: /^@design\//, replacement: DESIGN_SRC + "/" },
        { find: /^@app\//, replacement: APP_SRC + "/" },
        // The compiled web sources import @mycadet/avatar-catalog (the
        // bundled avatar SVG data); resolve it from the repo layout directly
        // so the build never depends on which workspace member's node_modules
        // a fresh CI install materialized.
        {
          find: "@mycadet/avatar-catalog",
          replacement: path.resolve(
            import.meta.dirname,
            "../../packages/avatar-catalog/src/index.ts",
          ),
        },
      ],
      dedupe: ["react", "react-dom"],
    },
    server: {
      port: Number(env.PORT || "3001"),
      strictPort: true,
      host: true,
      fs: {
        allow: [
          import.meta.dirname,
          WEB_SRC,
          DESIGN_SRC,
          path.resolve(import.meta.dirname, "../../assistant/src/api"),
        ],
      },
      proxy: {
        "/v1": {
          target: platform,
          changeOrigin: true,
          configure: injectCloudSessionToken(true, getDevCloudSessionToken),
        },
        "/_allauth": {
          target: platform,
          changeOrigin: true,
          configure: injectCloudSessionToken(false, getDevCloudSessionToken),
        },
        "/accounts": {
          target: platform,
          changeOrigin: true,
          configure: injectCloudSessionToken(false, getDevCloudSessionToken),
        },
        "/auth": {
          target: env.GATEWAY_PROXY_TARGET || "http://localhost:7830",
          changeOrigin: true,
        },
      },
    },
    build: {
      outDir:
        target === "package"
          ? "dist/package"
          : target === "capacitor"
            ? "dist/capacitor"
            : "dist/standalone",
      ...(library
        ? {
            lib: {
              entry: {
                index: path.resolve(APP_SRC, "index.ts"),
                contracts: path.resolve(APP_SRC, "contracts.ts"),
              },
              formats: ["es"],
              fileName: (_format: string, name: string) => `${name}.js`,
            },
            rolldownOptions: {
              external: [
                /^react(?:\/|$)/,
                /^react-dom(?:\/|$)/,
                ...Object.keys(packageDependencies),
              ],
            },
          }
        : target === "capacitor"
          ? {
              // The root index.html is the standalone entry; the boot
              // bundle builds from its own document instead.
              rolldownOptions: {
                input: path.resolve(import.meta.dirname, "capacitor.html"),
              },
            }
          : {}),
      emptyOutDir: true,
      // Served bundles keep maps unconditionally (the #384 debugging
      // posture); the boot bundle rides inside the native download, where
      // 1.7MB of maps on a splash bundle is pure bloat.
      sourcemap: target !== "capacitor",
    },
  };
});
