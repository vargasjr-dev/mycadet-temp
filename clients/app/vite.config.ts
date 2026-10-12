import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite";

// The account tree's `@/` imports bridge to web's shared modules — the same
// alias web's own build uses, so both bundles compile those imports against
// the same sources and the two never drift.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      {
        find: /^@\//,
        replacement: path.resolve(import.meta.dirname, "../web/src") + "/",
      },
    ],
    dedupe: ["react", "react-dom"],
  },
});
