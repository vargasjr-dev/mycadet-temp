import { spawnSync } from "node:child_process";
import { basename, resolve } from "node:path";

// The headless Capacitor build (`bun run build`): builds the boot bundle
// from the sibling @mycadet/app package and syncs it into the Gradle
// project. This is what the release workflows call before their Gradle
// step; the local flow (`bun run dev`) wraps it with the emulator
// bootstrap in dev.ts.
const androidRoot = resolve(import.meta.dir, "..");
const appRoot = resolve(androidRoot, "../app");

function run(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): void {
  console.log(`\n> ${basename(command)} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

/**
 * Builds the boot bundle with `env` and syncs it into the native project.
 * The stamp must resolve from the same environment the sync consumes —
 * the baked `__CADET_CONFIG__.handoffUrl` and the config's
 * `allowNavigation` have to agree, or the handoff opens the system browser.
 */
export function buildAndSyncAndroid(env: NodeJS.ProcessEnv): void {
  run(process.execPath, ["run", "build:capacitor"], env, appRoot);
  run(
    process.execPath,
    ["x", "--bun", "cap", "sync", "android"],
    env,
    androidRoot,
  );
}

if (import.meta.main) {
  buildAndSyncAndroid(process.env);
}
