import {
  afterAll,
  afterEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import * as childProcess from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAppDistDir, resolveWebDistDir } from "../lib/web-dist.js";

const realChildProcess = { ...childProcess };
const spawnMock = mock(childProcess.spawn);

mock.module("node:child_process", () => ({
  ...childProcess,
  spawn: spawnMock,
}));

// Restore the real modules once this file finishes so the mocks do not leak
// into sibling test files in the same `bun test` run.
afterAll(() => {
  mock.module("node:child_process", () => realChildProcess);
});

afterEach(() => {
  spawnMock.mockReset();
  spawnMock.mockImplementation(realChildProcess.spawn);
});

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

/** A build spawn that must never fire: a build here is a bug. */
function unexpectedSpawn(): typeof childProcess.spawn {
  return (() => {
    throw new Error("unexpected spawn");
  }) as unknown as typeof childProcess.spawn;
}

/**
 * A build-spawn fake: optionally "lands" the bundle files where the real
 * build would write them, then exits with the given code.
 */
function fakeBuildSpawn(
  code: number,
  land?: () => void,
): typeof childProcess.spawn {
  return (() => {
    land?.();
    const child = new childProcess.ChildProcess();
    setTimeout(() => child.emit("exit", code), 10);
    return child;
  }) as unknown as typeof childProcess.spawn;
}

describe("resolveWebDistDir", () => {
  test("returns the source-checkout dist without building when present", async () => {
    const root = makeRoot();
    const distDir = join(root, "clients", "web", "dist");
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, "index.html"), "<html></html>");
    spawnMock.mockImplementation(unexpectedSpawn());

    const resolved = await resolveWebDistDir({
      startDir: root,
      resolvePackage: resolvePackageThrows,
    });

    expect(resolved).toBe(distDir);
    expect(spawnMock.mock.calls).toHaveLength(0);
  });

  test("builds the missing bundle once from the source checkout", async () => {
    const root = makeRoot();
    const packageDir = join(root, "clients", "web");
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, "package.json"), "{}");
    const logSpy = spyOn(console, "log");
    spawnMock.mockImplementation(
      fakeBuildSpawn(0, () => {
        mkdirSync(join(packageDir, "dist"), { recursive: true });
        writeFileSync(join(packageDir, "dist", "index.html"), "<html></html>");
      }),
    );

    const resolved = await resolveWebDistDir({
      startDir: root,
      resolvePackage: resolvePackageThrows,
    });

    expect(resolved).toBe(join(packageDir, "dist"));
    expect(
      logSpy.mock.calls.some((call) =>
        call.join(" ").includes("No built web bundle found"),
      ),
    ).toBe(true);
    logSpy.mockRestore();

    const [command, args, options] = spawnMock.mock.calls[0] ?? [];
    expect(command).toBe("bun");
    expect(args).toEqual(["run", "build"]);
    expect(options?.env?.VITE_CLOUD_MODE).toBe("false");
    expect(options?.cwd).toBe(packageDir);

    // The second resolve finds the built bundle without rebuilding.
    expect(
      await resolveWebDistDir({
        startDir: root,
        resolvePackage: resolvePackageThrows,
      }),
    ).toBe(join(packageDir, "dist"));
    expect(spawnMock.mock.calls).toHaveLength(1);
  });

  test("returns null when there is no dist and no source package to build", async () => {
    const root = makeRoot();
    spawnMock.mockImplementation(unexpectedSpawn());

    const resolved = await resolveWebDistDir({
      startDir: root,
      resolvePackage: resolvePackageThrows,
    });

    expect(resolved).toBeNull();
    expect(spawnMock.mock.calls).toHaveLength(0);
  });

  test("reports a failed source build with the manual recipe", async () => {
    const root = makeRoot();
    const packageDir = join(root, "clients", "web");
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, "package.json"), "{}");
    const logSpy = spyOn(console, "log");
    spawnMock.mockImplementation(fakeBuildSpawn(1));

    await expect(
      resolveWebDistDir({
        startDir: root,
        resolvePackage: resolvePackageThrows,
      }),
    ).rejects.toThrow("cd clients/web && VITE_CLOUD_MODE=false bun run build");
    expect(
      logSpy.mock.calls.some((call) =>
        call.join(" ").includes("No built web bundle found"),
      ),
    ).toBe(true);
    logSpy.mockRestore();
  });
});

describe("resolveAppDistDir", () => {
  test("mirrors the auto-build for the app shell bundle", async () => {
    const root = makeRoot();
    const packageDir = join(root, "clients", "app");
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, "package.json"), "{}");
    const logSpy = spyOn(console, "log");
    spawnMock.mockImplementation(
      fakeBuildSpawn(0, () => {
        mkdirSync(join(packageDir, "dist", "standalone"), { recursive: true });
        writeFileSync(
          join(packageDir, "dist", "standalone", "index.html"),
          "<html></html>",
        );
      }),
    );

    const resolved = await resolveAppDistDir({
      startDir: root,
      resolvePackage: resolvePackageThrows,
    });

    expect(resolved).toBe(join(packageDir, "dist", "standalone"));
    logSpy.mockRestore();

    const [command, args, options] = spawnMock.mock.calls[0] ?? [];
    expect(command).toBe("bun");
    expect(args).toEqual(["run", "build"]);
    expect(options?.cwd).toBe(packageDir);
  });
});
