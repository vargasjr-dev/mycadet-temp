import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { build } from "vite";
import { injectedConfigScript } from "../src/capacitor/stamp";

// The Capacitor app bundle: one `capacitor.html` entry booting the same
// `main.tsx` app shell every other host serves, built root-based into
// dist/capacitor and stamped with the environment-resolved
// `__CADET_CONFIG__`. The stamp happens at build time (not cap-sync time)
// because the resolution is pure environment reading — the same
// `CADET_ENVIRONMENT` / `CADET_SERVER_URL` inputs the native `server.url`
// bake used to consume at sync time.
process.env.APP_BUILD_TARGET = "capacitor";
await build();

// Vite emits the html under its root-relative name; cap sync serves
// `<webDir>/index.html` as the start page, so the entry file is renamed.
const distDir = path.resolve(import.meta.dirname, "../dist/capacitor");
const builtHtml = path.join(distDir, "capacitor.html");
const indexHtml = path.join(distDir, "index.html");
renameSync(builtHtml, indexHtml);

const html = readFileSync(indexHtml, "utf8");
const marker = "</head>";
if (!html.includes(marker)) {
  throw new Error("Built app index.html has no </head> to stamp.");
}
// The function-form replacement keeps `$` sequences in the JSON payload
// from being interpreted as replacement patterns.
writeFileSync(
  indexHtml,
  html.replace(marker, () => `${injectedConfigScript()}${marker}`),
);

const stamped = readFileSync(indexHtml, "utf8");
if (!stamped.includes("window.__CADET_CONFIG__=")) {
  throw new Error("Injected config stamp did not land.");
}
