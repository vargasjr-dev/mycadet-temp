import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveAppDistDir,
  resolveWebDistDir,
  type DistBuildSpec,
} from "../lib/web-dist.js";

const roots: string[] = [];

function makeRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "web-dist-"));
  roots.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of roots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Defeats the npm package arm so fixtures are the only resolution source. */
function resolvePackageThrows(): string {
  throw new Error("no npm package in this fixture");
}

describe("resolveWebDistDir", () => {
  test("returns the source-checkout dist without building when present", async () => {
    const root = makeRoot();
    const distDir = join(root, "clients", "web", "dist");
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, "index.html"), "<html></html>");

    const builds: DistBuildSpec[] = [];
    const resolved = await resolveWebDistDir({
      startDir: root,
      resolvePackage: resolvePackageThrows,
      runBuild: async (build) => {
        builds.push(build);
      },
    });

    expect(resolved).toBe(distDir);
    expect(builds).toHaveLength(0);
  });

  test("builds the missing bundle once from the source checkout", async () => {
    const root = makeRoot();
    const packageDir = join(root, "clients", "web");
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, "package.json"), "{}");

    const builds: DistBuildSpec[] = [];
    const resolve = async (): Promise<string | null> =>
      resolveWebDistDir({
        startDir: root,
        resolvePackage: resolvePackageThrows,
        log: () => {},
        runBuild: async (build) => {
          builds.push(build);
          const distDir = join(packageDir, "dist");
          mkdirSync(distDir, { recursive: true });
          writeFileSync(join(distDir, "index.html"), "<html></html>");
        },
      });

    const resolved = await resolve();
    expect(resolved).toBe(join(packageDir, "dist"));
    expect(builds).toHaveLength(1);
    expect(builds[0]?.command).toBe("bun");
    expect(builds[0]?.args).toEqual(["run", "build"]);
    expect(builds[0]?.env.VITE_CLOUD_MODE).toBe("false");
    expect(builds[0]?.cwd).toBe(packageDir);

    // The second resolve finds the built bundle without rebuilding.
    expect(await resolve()).toBe(join(packageDir, "dist"));
    expect(builds).toHaveLength(1);
  });

  test("returns null when there is no dist and no source package to build", async () => {
    const root = makeRoot();
    const builds: DistBuildSpec[] = [];
    const resolved = await resolveWebDistDir({
      startDir: root,
      resolvePackage: resolvePackageThrows,
      runBuild: async (build) => {
        builds.push(build);
      },
    });

    expect(resolved).toBeNull();
    expect(builds).toHaveLength(0);
  });

  test("reports a failed source build with the manual recipe", async () => {
    const root = makeRoot();
    const packageDir = join(root, "clients", "web");
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, "package.json"), "{}");
    const logs: string[] = [];

    await expect(
      resolveWebDistDir({
        startDir: root,
        resolvePackage: resolvePackageThrows,
        log: (message) => logs.push(message),
        runBuild: async () => {
          throw new Error("bun exited with code 1");
        },
      }),
    ).rejects.toThrow("cd clients/web && VITE_CLOUD_MODE=false bun run build");
    expect(
      logs.some((line) => line.includes("No built web bundle found")),
    ).toBe(true);
  });
});

describe("resolveAppDistDir", () => {
  test("mirrors the auto-build for the app shell bundle", async () => {
    const root = makeRoot();
    const packageDir = join(root, "clients", "app");
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, "package.json"), "{}");

    const builds: DistBuildSpec[] = [];
    const resolved = await resolveAppDistDir({
      startDir: root,
      resolvePackage: resolvePackageThrows,
      log: () => {},
      runBuild: async (build) => {
        builds.push(build);
        const distDir = join(packageDir, "dist", "standalone");
        mkdirSync(distDir, { recursive: true });
        writeFileSync(join(distDir, "index.html"), "<html></html>");
      },
    });

    expect(resolved).toBe(join(packageDir, "dist", "standalone"));
    expect(builds).toHaveLength(1);
    expect(builds[0]?.cwd).toBe(packageDir);
  });
});
