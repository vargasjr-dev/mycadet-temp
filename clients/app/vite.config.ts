import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import {
  defineConfig,
  type ConfigEnv,
  type Plugin,
  type UserConfig,
} from "vite";
import webConfig from "../web/vite.config";

const APP_SRC = path.resolve(import.meta.dirname, "src");
const WEB_SRC = path.resolve(import.meta.dirname, "../web/src");
const SUFFIXES = ["", ".ts", ".tsx", ".css", "/index.ts", "/index.tsx"];

// `@/` resolves app sources first, then falls through to web's shared
// modules — both trees were one tree before the account split, so the
// import spellings are identical on either side of the fallback.
function aliasFallback(): Plugin {
  return {
    name: "app-alias-fallback",
    enforce: "pre",
    resolveId(source) {
      if (!source.startsWith("@/")) return null;
      const rest = source.slice(2);
      for (const root of [APP_SRC, WEB_SRC]) {
        for (const suffix of SUFFIXES) {
          const candidate = path.join(root, rest + suffix);
          if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            return candidate;
          }
        }
      }
      return null;
    },
  };
}

const webFactory = webConfig as unknown as (env: ConfigEnv) => UserConfig;

// The desktop renderer builds web's full config (base, dev proxy, chunk
// groups) and composes the account routes into the tree on top.
export default defineConfig((env) => {
  const web = webFactory(env);
  return {
    ...web,
    publicDir: "../web/public",
    plugins: [...(web.plugins ?? []), aliasFallback()],
    resolve: { ...web.resolve, alias: [] },
  };
});
