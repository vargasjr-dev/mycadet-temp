import path from "node:path";

import { appendFileSync } from "node:fs";

import { readRuntimeManifest } from "../src/main/cli-installer";
import {
  resolveCliLauncherPaths,
  uninstallCliLauncher,
} from "../src/main/cli-path-installer";

export function uninstallPackagedCli(
  execPath: string,
  localAppData: string,
  uninstallLauncher: typeof uninstallCliLauncher = uninstallCliLauncher,
): void {
  const runtimeDir = path.dirname(execPath);
  const releaseChannel =
    readRuntimeManifest(runtimeDir)?.releaseChannel ?? "production";
  const result = uninstallLauncher(
    resolveCliLauncherPaths(localAppData, releaseChannel),
    undefined,
    path.dirname(runtimeDir),
  );
  if (result === "blocked") {
    throw new Error(
      "Unable to remove the Cadet command launcher. Close active cadet commands and try again.",
    );
  }
}

if (import.meta.main) {
  const trace = (line: string): void => {
    try {
      if (process.env.TEMP) {
        appendFileSync(
          path.join(process.env.TEMP, "cadet-uninstall-cli.log"),
          `[${new Date().toISOString()}] ${line}\n`,
        );
      }
    } catch {}
  };
  trace(`start; execPath=${process.execPath}`);
  try {
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData) {
      throw new Error("LOCALAPPDATA is unavailable. Retry uninstalling Cadet.");
    }
    uninstallPackagedCli(process.execPath, localAppData);
    trace("ok");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    trace(`failed: ${message}`);
    console.error(message);
    process.exitCode = 1;
  }
}
