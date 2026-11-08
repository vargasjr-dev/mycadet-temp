import { spawnSync } from "child_process";
import { cpSync, mkdirSync, readdirSync, statSync, rmSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { build } from "vite";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = resolve(__dirname, "../../../skills");
const PUBLIC_SKILLS_DIR = resolve(__dirname, "../public/skills");

if (statSync(PUBLIC_SKILLS_DIR, { throwIfNoEntry: false })?.isDirectory()) {
  rmSync(PUBLIC_SKILLS_DIR, { recursive: true });
}

let copied = 0;

for (const entry of readdirSync(SKILLS_DIR, { withFileTypes: true })) {
  if (!entry.isDirectory()) {
    continue;
  }

  const assetsDir = join(SKILLS_DIR, entry.name, "assets");
  if (!statSync(assetsDir, { throwIfNoEntry: false })?.isDirectory()) {
    continue;
  }

  const destDir = join(PUBLIC_SKILLS_DIR, entry.name, "assets");
  mkdirSync(destDir, { recursive: true });
  cpSync(assetsDir, destDir, { recursive: true });
  copied++;
}

console.log(`Copied assets from ${copied} skill(s) to ${PUBLIC_SKILLS_DIR}`);

// Best-effort node_modules top-up. --ignore-scripts: the 10s cap must never
// kill a lifecycle script mid-write — the web postinstall regenerates the
// API clients, and codegen interrupted halfway leaves src/generated emptied.
const install = spawnSync("bun", ["install", "--ignore-scripts"], {
  cwd: resolve(import.meta.dirname, ".."),
  stdio: "inherit",
  timeout: 10 * 1000,
});
if (install.status !== 0) {
  console.warn(
    `bun install failed with exit code ${install.status ?? "signal"}, continuing...`,
  );
}

await build();
