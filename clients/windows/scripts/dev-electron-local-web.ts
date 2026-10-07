import path from "node:path";

const packageDir = path.resolve(import.meta.dir, "..");

export const platformOriginFromDevUrl = (value: string): string => {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("CADET_DEV_URL must use http or https");
  }
  return url.origin;
};

const run = async (
  args: string[],
  env: Record<string, string | undefined>,
): Promise<number> => {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd: packageDir,
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    windowsHide: true,
  });
  return child.exited;
};

const main = async (): Promise<void> => {
  const remoteUrl = process.env.CADET_DEV_URL;
  if (!remoteUrl) {
    throw new Error(
      "Set CADET_DEV_URL to the remote platform URL, for example https://dev.mycadet.ai/assistant",
    );
  }

  const platformOrigin = platformOriginFromDevUrl(remoteUrl);
  const buildExitCode = await run(["run", "build:web"], {
    ...process.env,
    VITE_PLATFORM_MODE: "false",
  });
  if (buildExitCode !== 0) {
    process.exit(buildExitCode);
  }

  process.exit(
    await run(["run", "dev:electron-only"], {
      ...process.env,
      CADET_LOCAL_RENDERER: "true",
      CADET_PLATFORM_URL: platformOrigin,
      CADET_WEB_URL: platformOrigin,
    }),
  );
};

if (import.meta.main) {
  await main();
}
