import { spawnSync } from "node:child_process";
import path from "node:path";
import { build } from "vite";

// The install is part of the build: a pulled checkout can move the lockfile
// under dist's feet, so `bun run build` (the edge auto-build's recipe too)
// refreshes deps itself before bundling.
const install = spawnSync("bun", ["install"], {
  cwd: path.resolve(import.meta.dirname, ".."),
  stdio: "inherit",
  timeout: 10 * 1000,
});
if (install.status !== 0) {
  console.warn(
    `bun install failed with exit code ${install.status ?? "signal"}, continuing...`,
  );
}

// Both entry formats share vite.config.ts and the exported app implementation.
for (const target of ["package", "standalone"]) {
  process.env.APP_BUILD_TARGET = target;
  await build();
}
