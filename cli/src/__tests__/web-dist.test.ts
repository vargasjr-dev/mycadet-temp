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
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
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

/**
 * The HEAD sha the fixture's git boundary reports. null = a git-less tree
 * (rev-parse fails), which keeps staleness detection inert.
 */
let fixtureHeadSha: string | null = null;

afterEach(() => {
  spawnMock.mockReset();
  spawnMock.mockImplementation(realChildProcess.spawn);
  fixtureHeadSha = null;
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

/** A git child that answers rev-parse with the fixture HEAD, or fails. */
function fakeGitChild(): childProcess.ChildProcess {
  const child = new childProcess.ChildProcess();
  if (fixtureHeadSha === null) {
    Object.defineProperty(child, "stdout", { value: null });
    setTimeout(() => child.emit("exit", 128), 0);
    return child;
  }
  const stream = new PassThrough();
  Object.defineProperty(child, "stdout", { value: stream });
  setTimeout(() => {
    stream.write(`${fixtureHeadSha}\n`);
    stream.end();
    child.emit("exit", 0);
  }, 0);
  return child;
}

/**
 * The process-boundary fake: git rev-parse answers with the fixture HEAD,
 * and bun spawns run the fake build — optionally "landing" the bundle files
 * where the real build would write them — then exit with the given code.
 */
function fakeSpawn(
  landBun?: () => void,
  bunCode = 0,
): typeof childProcess.spawn {
  return ((command: string) => {
    if (command === "git") {
      return fakeGitChild();
    }
    landBun?.();
    const child = new childProcess.ChildProcess();
    setTimeout(() => child.emit("exit", bunCode), 10);
    return child;
  }) as unknown as typeof childProcess.spawn;
}

/** A build spawn that must never fire: a build here is a bug. */
function unexpectedSpawn(): typeof childProcess.spawn {
  return (() => {
    throw new Error("unexpected spawn");
  }) as unknown as typeof childProcess.spawn;
}

function bunCalls(): Array<Parameters<typeof childProcess.spawn>> {
  return spawnMock.mock.calls.filter(([command]) => command === "bun") as Array<
    Parameters<typeof childProcess.spawn>
  >;
}

function seedWebDist(packageDir: string): string {
  const distDir = join(packageDir, "dist");
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, "index.html"), "<html></html>");
  return distDir;
}

describe("resolveWebDistDir", () => {
  test("returns the source-checkout dist without building when present", async () => {
    const root = makeRoot();
    const distDir = seedWebDist(join(root, "clients", "web"));
    // git-less tree: staleness detection is inert, the dist serves as-is.
    fixtureHeadSha = null;
    spawnMock.mockImplementation(fakeSpawn());

    const resolved = await resolveWebDistDir({
      startDir: root,
      resolvePackage: resolvePackageThrows,
    });

    expect(resolved).toBe(distDir);
    expect(bunCalls()).toHaveLength(0);
  });

  test("builds the missing bundle once from the source checkout", async () => {
    const root = makeRoot();
    const packageDir = join(root, "clients", "web");
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, "package.json"), "{}");
    fixtureHeadSha = "a".repeat(40);
    const logSpy = spyOn(console, "log");
    spawnMock.mockImplementation(
      fakeSpawn(() => {
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

    const [command, args, options] = bunCalls()[0] ?? [];
    expect(command).toBe("bun");
    expect(args).toEqual(["run", "build"]);
    expect(options?.env?.VITE_CLOUD_MODE).toBe("false");
    expect(options?.cwd).toBe(packageDir);
    // The build is stamped with the commit it consumed.
    expect(
      readFileSync(join(packageDir, ".cadet-built-sha"), "utf8").trim(),
    ).toBe(fixtureHeadSha);

    // The second resolve finds a fresh stamp and does not rebuild.
    expect(
      await resolveWebDistDir({
        startDir: root,
        resolvePackage: resolvePackageThrows,
      }),
    ).toBe(join(packageDir, "dist"));
    expect(bunCalls()).toHaveLength(1);
  });

  test("rebuilds the bundle when the checkout moved past it", async () => {
    const root = makeRoot();
    const packageDir = join(root, "clients", "web");
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, "package.json"), "{}");
    const distDir = seedWebDist(packageDir);
    writeFileSync(join(packageDir, ".cadet-built-sha"), `${"b".repeat(40)}\n`);
    // The pull moved HEAD past the stamped build.
    fixtureHeadSha = "c".repeat(40);
    const logSpy = spyOn(console, "log");
    spawnMock.mockImplementation(
      fakeSpawn(() => {
        writeFileSync(join(packageDir, "dist", "index.html"), "<html>2</html>");
      }),
    );

    const resolved = await resolveWebDistDir({
      startDir: root,
      resolvePackage: resolvePackageThrows,
    });

    expect(resolved).toBe(distDir);
    expect(bunCalls()).toHaveLength(1);
    expect(
      logSpy.mock.calls.some((call) =>
        call.join(" ").includes("older than the current checkout"),
      ),
    ).toBe(true);
    logSpy.mockRestore();
    expect(
      readFileSync(join(packageDir, ".cadet-built-sha"), "utf8").trim(),
    ).toBe(fixtureHeadSha);
  });

  test("serves the fresh bundle without rebuilding", async () => {
    const root = makeRoot();
    const packageDir = join(root, "clients", "web");
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, "package.json"), "{}");
    const distDir = seedWebDist(packageDir);
    fixtureHeadSha = "d".repeat(40);
    writeFileSync(join(packageDir, ".cadet-built-sha"), `${fixtureHeadSha}\n`);
    spawnMock.mockImplementation(fakeSpawn());

    const resolved = await resolveWebDistDir({
      startDir: root,
      resolvePackage: resolvePackageThrows,
    });

    expect(resolved).toBe(distDir);
    expect(bunCalls()).toHaveLength(0);
  });

  test("rebuilds a bundle that predates the build stamp once", async () => {
    const root = makeRoot();
    const packageDir = join(root, "clients", "web");
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, "package.json"), "{}");
    const distDir = seedWebDist(packageDir);
    fixtureHeadSha = "e".repeat(40);
    const logSpy = spyOn(console, "log");
    spawnMock.mockImplementation(fakeSpawn());

    const resolved = await resolveWebDistDir({
      startDir: root,
      resolvePackage: resolvePackageThrows,
    });

    expect(resolved).toBe(distDir);
    expect(bunCalls()).toHaveLength(1);
    expect(
      logSpy.mock.calls.some((call) =>
        call.join(" ").includes("no build stamp"),
      ),
    ).toBe(true);
    logSpy.mockRestore();
    expect(
      readFileSync(join(packageDir, ".cadet-built-sha"), "utf8").trim(),
    ).toBe(fixtureHeadSha);
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
    fixtureHeadSha = "f".repeat(40);
    const logSpy = spyOn(console, "log");
    spawnMock.mockImplementation(fakeSpawn(undefined, 1));

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

  test("leaves an installed-package dist alone even with a stale source checkout", async () => {
    const root = makeRoot();
    // The npm arm resolves first and owns the dist; the source checkout may
    // be as stale as it likes.
    const npmPackageDir = join(root, "npm", "@mycadet", "web");
    seedWebDist(npmPackageDir);
    const packageDir = join(root, "clients", "web");
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, "package.json"), "{}");
    seedWebDist(packageDir);
    fixtureHeadSha = "1".repeat(40);
    writeFileSync(join(packageDir, ".cadet-built-sha"), `${"0".repeat(40)}\n`);
    spawnMock.mockImplementation(unexpectedSpawn());

    const resolved = await resolveWebDistDir({
      startDir: root,
      resolvePackage: () => join(npmPackageDir, "package.json"),
    });

    expect(resolved).toBe(join(npmPackageDir, "dist"));
    expect(spawnMock.mock.calls).toHaveLength(0);
  });
});

describe("resolveAppDistDir", () => {
  test("mirrors the auto-build for the app shell bundle", async () => {
    const root = makeRoot();
    const packageDir = join(root, "clients", "app");
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, "package.json"), "{}");
    fixtureHeadSha = "2".repeat(40);
    const logSpy = spyOn(console, "log");
    spawnMock.mockImplementation(
      fakeSpawn(() => {
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

    const [command, args, options] = bunCalls()[0] ?? [];
    expect(command).toBe("bun");
    expect(args).toEqual(["run", "build"]);
    expect(options?.cwd).toBe(packageDir);
    expect(
      readFileSync(join(packageDir, ".cadet-built-sha"), "utf8").trim(),
    ).toBe(fixtureHeadSha);
  });

  test("rebuilds a stale app-shell bundle from the moved checkout", async () => {
    const root = makeRoot();
    const packageDir = join(root, "clients", "app");
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, "package.json"), "{}");
    const distDir = join(packageDir, "dist", "standalone");
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, "index.html"), "<html></html>");
    writeFileSync(join(packageDir, ".cadet-built-sha"), `${"3".repeat(40)}\n`);
    fixtureHeadSha = "4".repeat(40);
    spawnMock.mockImplementation(fakeSpawn());

    const resolved = await resolveAppDistDir({
      startDir: root,
      resolvePackage: resolvePackageThrows,
    });

    expect(resolved).toBe(distDir);
    expect(bunCalls()).toHaveLength(1);
    expect(
      readFileSync(join(packageDir, ".cadet-built-sha"), "utf8").trim(),
    ).toBe(fixtureHeadSha);
  });
});
