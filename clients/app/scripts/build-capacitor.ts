import { renameSync } from "node:fs";
import path from "node:path";
import { build } from "vite";

// The Capacitor app bundle: one `capacitor.html` entry booting the same
// `main.tsx` app shell every other host serves. The bundle carries no
// config stamp — the shell boots on local assets and the native config
// (`capacitor.config.json`, resolved at sync time) owns the baked origins.
process.env.APP_BUILD_TARGET = "capacitor";
await build();

// Vite emits the html under its root-relative name; cap sync serves
// `<webDir>/index.html` as the start page, so the entry file is renamed.
const distDir = path.resolve(import.meta.dirname, "../dist/capacitor");
const builtHtml = path.join(distDir, "capacitor.html");
const indexHtmlPath = path.join(distDir, "index.html");
renameSync(builtHtml, indexHtmlPath);
