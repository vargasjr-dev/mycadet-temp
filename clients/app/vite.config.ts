import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";

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

export default defineConfig({
  plugins: [react(), tailwindcss(), aliasFallback()],
  resolve: {
    dedupe: ["react", "react-dom"],
  },
});
