import { configureLockfileWatcher } from "@mycadet/electron-desktop/lockfile-watcher";
import { resolveLockfilePaths } from "@mycadet/local-mode";

configureLockfileWatcher(() => resolveLockfilePaths(process.env));

export * from "@mycadet/electron-desktop/lockfile-watcher";
