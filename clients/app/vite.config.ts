import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { injectCloudSessionToken } from "./vite/cloud-proxy";
import {
  localModePlugin,
  getDevPlatformToken,
} from "../web/vite-plugin-local-mode";

const APP_SRC = path.resolve(import.meta.dirname, "src");
const WEB_SRC = path.resolve(import.meta.dirname, "../web/src");
const DESIGN_SRC = path.resolve(
  import.meta.dirname,
  "../../packages/design-library/src",
);

export default defineConfig(({ mode }) => {
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
    base: "/assistant/",
    define: { __INCLUDES_ACCOUNT__: "false" },
    plugins: [tailwindcss(), react(), ...(cloud ? [] : [localModePlugin(env)])],
    publicDir: "../web/public",
    resolve: {
      alias: [
        { find: /^@design\//, replacement: DESIGN_SRC + "/" },
        { find: /^@app\//, replacement: APP_SRC + "/" },
        { find: /^@web\//, replacement: WEB_SRC + "/" },
        { find: /^@\//, replacement: WEB_SRC + "/" },
      ],
      dedupe: ["react", "react-dom"],
    },
    optimizeDeps: {
      include: ["rehype-katex", "remark-math", "remark-parse", "unified"],
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
                configure: injectCloudSessionToken(true, getDevPlatformToken),
              }),
        },
        "/_allauth": {
          target: platform,
          changeOrigin: true,
          ...(cloud
            ? {}
            : {
                configure: injectCloudSessionToken(false, getDevPlatformToken),
              }),
        },
        "/accounts": {
          target: platform,
          changeOrigin: true,
          ...(cloud
            ? {}
            : {
                configure: injectCloudSessionToken(false, getDevPlatformToken),
              }),
        },
        "/auth": {
          target: env.GATEWAY_PROXY_TARGET || "http://localhost:7830",
          changeOrigin: true,
        },
      },
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
      sourcemap: !cloud,
      ...(cloud ? {} : { minify: false as const }),
    },
  };
});
