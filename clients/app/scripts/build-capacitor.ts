import {
  cpSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { build } from "vite";
import {
  bootConfigScript,
  capacitorBootConfig,
} from "../src/capacitor/boot-config";

// The Capacitor boot bundle: one `capacitor.html` entry built root-based
// into dist/capacitor, then stamped with the environment-resolved
// `__CADET_CONFIG__` so the baked shell knows where to hand off. The stamp
// happens at build time (not cap-sync time) because the resolution is pure
// environment reading — the same `CADET_ENVIRONMENT` / `CADET_SERVER_URL`
// inputs the native `server.url` bake used to consume at sync time.
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
  throw new Error("Built boot index.html has no </head> to stamp.");
}
// The function-form replacement keeps `$` sequences in the JSON payload
// from being interpreted as replacement patterns.
writeFileSync(
  indexHtml,
  html.replace(
    marker,
    () => `${bootConfigScript(capacitorBootConfig(process.env))}${marker}`,
  ),
);

const stamped = readFileSync(indexHtml, "utf8");
if (!stamped.includes("window.__CADET_CONFIG__=")) {
  throw new Error("Boot config stamp did not land.");
}

// The baked web bundle: clients/web's local-mode build copied under
// `dist/capacitor/assistant/`, so the boot bundle's `/assistant/` handoff
// resolves the SPA from the shell's own assets — nothing needs to be
// listening on localhost:3000 for the app to render. The build is forced to
// the local cadet's shape (VITE_CLOUD_MODE=false keeps `isLocalClient()`
// true, CADET_ENVIRONMENT=local stamps the loopback seeds) because only the
// local arm ever loads this bundle: remote arms hand off before it could.
const webRoot = path.resolve(import.meta.dirname, "../../web");
const webBuild = Bun.spawnSync({
  cwd: webRoot,
  cmd: ["bun", "run", "build"],
  env: {
    ...process.env,
    VITE_CLOUD_MODE: "false",
    VITE_WEB_MINIFY: "1",
    CADET_ENVIRONMENT: "local",
  },
  stdout: "inherit",
  stderr: "inherit",
});
if (webBuild.exitCode !== 0) {
  throw new Error(
    `clients/web build failed for the capacitor bake (exit ${webBuild.exitCode}).`,
  );
}

const assistantBundle = path.resolve(distDir, "assistant");
cpSync(path.resolve(webRoot, "dist"), assistantBundle, { recursive: true });

// The web build's sourcemaps (#384 ships them unconditionally for served
// bundles) are ~50MB of devtools-only weight here — the same trim the boot
// bundle's capacitor target applies. The minified chunks keep their
// sourceMappingURL comments; a debugger that wants maps reads the served
// artifact instead.
for (const file of readdirSync(assistantBundle, { recursive: true })) {
  if (file.endsWith(".map")) {
    rmSync(path.join(assistantBundle, file));
  }
}

const bakedWebIndex = readFileSync(
  path.join(assistantBundle, "index.html"),
  "utf8",
);
if (!bakedWebIndex.includes("window.__CADET_CONFIG__=")) {
  throw new Error("Baked web bundle carries no local-mode config stamp.");
}
