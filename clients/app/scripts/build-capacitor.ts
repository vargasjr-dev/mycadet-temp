import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { build } from "vite";

process.env.APP_BUILD_TARGET = "capacitor";
await build();

// Vite emits the html under its root-relative name; cap sync serves
// `<webDir>/index.html` as the start page, so the entry file is renamed.
const distDir = path.resolve(import.meta.dirname, "../dist/capacitor");
const builtHtml = path.join(distDir, "capacitor.html");
const indexHtmlPath = path.join(distDir, "index.html");
renameSync(builtHtml, indexHtmlPath);

const html = readFileSync(indexHtmlPath, "utf8");
const marker = "</head>";
if (!html.includes(marker)) {
  throw new Error("Built app index.html has no </head> to stamp.");
}
// The function-form replacement keeps `$` sequences in the JSON payload
// from being interpreted as replacement patterns.
writeFileSync(indexHtmlPath, html);
