import path from "node:path";
import { appPackage, packageDependencies } from "./vite/app-package";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { injectCloudSessionToken } from "./vite/cloud-proxy";
import {
  localModePlugin,
  getDevCloudSessionToken,
} from "../web/vite-plugin-local-mode";

const APP_SRC = path.resolve(import.meta.dirname, "src");
const WEB_SRC = path.resolve(import.meta.dirname, "../web/src");
const DESIGN_SRC = path.resolve(
  import.meta.dirname,
  "../../packages/design-library/src",
);

export default defineConfig(({ mode, command }) => {
  const library = process.env.APP_BUILD_TARGET === "package";
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  Object.assign(env, loadEnv(mode, import.meta.dirname, ""));
  const cloud = ["1", "true", "yes"].includes(
    (env.VITE_CLOUD_MODE ?? "").toLowerCase(),
  );
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
      ...(library ? [appPackage()] : cloud ? [] : [localModePlugin(env)]),
    ],
    // The app owns its public assets (favicon, the signup media) — the
    // standalone bundle must be self-contained so a published @mycadet/app
    // package carries everything the edge-served shell needs.
    publicDir: true,
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
        { find: /^@web\//, replacement: WEB_SRC + "/" },
        { find: /^@\//, replacement: WEB_SRC + "/" },
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
          ...(cloud
            ? {}
            : {
                configure: injectCloudSessionToken(
                  true,
                  getDevCloudSessionToken,
                ),
              }),
        },
        "/_allauth": {
          target: platform,
          changeOrigin: true,
          ...(cloud
            ? {}
            : {
                configure: injectCloudSessionToken(
                  false,
                  getDevCloudSessionToken,
                ),
              }),
        },
        "/accounts": {
          target: platform,
          changeOrigin: true,
          ...(cloud
            ? {}
            : {
                configure: injectCloudSessionToken(
                  false,
                  getDevCloudSessionToken,
                ),
              }),
        },
        "/auth": {
          target: env.GATEWAY_PROXY_TARGET || "http://localhost:7830",
          changeOrigin: true,
        },
      },
    },
    build: {
      outDir: library ? "dist/package" : "dist/standalone",
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
        : {}),
      emptyOutDir: true,
      sourcemap: true,
    },
  };
});
