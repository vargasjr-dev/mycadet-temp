import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import webPackage from "./package.json";
import path from "node:path";
import { defineConfig, loadEnv, type Plugin } from "vite";

const DESIGN_LIBRARY_SRC = path.resolve(
  import.meta.dirname,
  "../../packages/design-library/src",
);
/**
 * Chunk-group predicate matching a module by the package directory that owns
 * it. The trailing separator is what keeps `react` from also capturing
 * `react-dom`, `react-router`, `react-markdown`, and friends.
 */
function inPackages(...names: string[]): (id: string) => boolean {
  const escaped = names.map((name) =>
    name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  const pattern = new RegExp(
    `[\\\\/]node_modules[\\\\/](?:${escaped.join("|")})[\\\\/]`,
  );
  return (id: string) => pattern.test(id);
}

// Truthy semantics for build-shape knobs that aren't about where the bundle
// is served from (e.g. VITE_WEB_MINIFY picks the minified prod build).
const ENV_FLAG_TRUTHY = new Set(["1", "true", "yes"]);
function isTruthyBuildFlag(raw: string | undefined): boolean {
  return !!raw && ENV_FLAG_TRUTHY.has(raw.toLowerCase());
}

// Reference: https://vite.dev/config/#using-environment-variables-in-config
export default defineConfig(({ mode }) => {
  // loadEnv with empty prefix loads all .env variables, not just VITE_-prefixed ones.
  const env = { ...process.env, ...loadEnv(mode, process.cwd(), "") };

  return {
    base: "/assistant/",
    plugins: [
      tailwindcss(),
      react(),
      {
        name: "assistant-release",
        generateBundle() {
          this.emitFile({
            type: "asset",
            fileName: "release.json",
            source: JSON.stringify({
              version: env.VITE_APP_VERSION || webPackage.version,
            }),
          });
        },
      } satisfies Plugin,
    ],
    resolve: {
      alias: [
        { find: /^@design\//, replacement: DESIGN_LIBRARY_SRC + "/" },
        {
          find: /^@\//,
          replacement: path.resolve(import.meta.dirname, "src") + "/",
        },
      ],
      dedupe: ["react", "react-dom"],
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
      // Source maps ship in EVERY bundle so devtools always shows origins —
      // minified prod and readable dev alike. Minification follows the
      // channel: the prod train sets VITE_WEB_MINIFY (the deploy hands phones
      // a cold cache), while dev-channel and self-hosted builds stay
      // unminified so QA and debugging can read them.
      sourcemap: true,
      ...(isTruthyBuildFlag(env.VITE_WEB_MINIFY) ? {} : { minify: false }),
      // Chunking is tuned for a cold cache on a phone, which is what every
      // deploy hands users: `index.html` modulepreloads the whole boot
      // graph, and hundreds of tiny chunks fetched at once stall a congested
      // mobile connection far more than the same bytes in a few files. These
      // groups collapse the boot graph to a handful of requests.
      //
      // INVARIANT when editing these groups: boot-critical bytes must not
      // grow. Boot-critical is the entry script plus every modulepreload
      // target in `dist/index.html`. Every group is tagged `$initial`, which
      // restricts it to modules statically reachable from the entry, so
      // lazy-only code (pdfjs, xterm, tiptap, per-route pages) can never be
      // merged into something boot has to fetch. Dropping a `$initial` tag,
      // or adding an untagged group, is how that gets broken. A healthy
      // build leaves a single-digit modulepreload count in `dist/index.html`
      // and no lazy-only package in the chunks it points at.
      //
      // The lazy side is deliberately left to automatic chunking. Collapsing
      // it too with an `entriesAware` group can deadlock the dynamic-import
      // runtime into a blank page with no build warning and no console
      // error, and which builds break is not stable across runs of the same
      // config.
      rolldownOptions: {
        output: {
          codeSplitting: {
            groups: [
              {
                name: "react",
                test: inPackages(
                  "react",
                  "react-dom",
                  "react-router",
                  "scheduler",
                ),
                tags: ["$initial"],
                priority: 50,
              },
              {
                name: "icons",
                test: inPackages("lucide-react"),
                tags: ["$initial"],
                priority: 45,
              },
              {
                name: "vendor",
                test: /[\\/]node_modules[\\/]/,
                tags: ["$initial"],
                priority: 40,
              },
              { name: "app", tags: ["$initial"], priority: 30 },
            ],
          },
        },
      },
    },
  };
});
