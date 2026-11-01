import {
  afterAll,
  afterEach,
  beforeEach,
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
import {
  readAppBuiltSha,
  stampAppBuiltSha,
  stampRootProcess,
} from "../lib/assistant-config.js";
import { resolveClientDists } from "../lib/web-dist.js";

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

// The built-sha stamp lives in the CLI lockfile now — each test redirects it
// to a temp dir (the root-process-lockfile.test.ts pattern).
const lockfileDirs: string[] = [];

beforeEach(() => {
  lockfileDirs.push(mkdtempSync(join(tmpdir(), "web-dist-lockfile-")));
  process.env.XDG_CONFIG_HOME = lockfileDirs.at(-1);
});

afterEach(() => {
  delete process.env.XDG_CONFIG_HOME;
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
  for (const dir of [...roots.splice(0), ...lockfileDirs.splice(0)]) {
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

function seedAppDist(packageDir: string): string {
  const distDir = join(packageDir, "dist", "standalone");
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, "index.html"), "<html></html>");
  return distDir;
}

/** A fixture checkout with both client packages declared. */
function seedCheckout(): { root: string; web: string; app: string } {
  const root = makeRoot();
  const web = join(root, "clients", "web");
  const app = join(root, "clients", "app");
  mkdirSync(web, { recursive: true });
  mkdirSync(app, { recursive: true });
  writeFileSync(join(web, "package.json"), "{}");
  writeFileSync(join(app, "package.json"), "{}");
  return { root, web, app };
}

describe("resolveClientDists", () => {
  test("returns both source-checkout dists without building when present", async () => {
    const { root, web, app } = seedCheckout();
    const webDist = seedWebDist(web);
    const appDist = seedAppDist(app);
    // git-less tree: staleness detection is inert, the dists serve as-is.
    fixtureHeadSha = null;
    spawnMock.mockImplementation(fakeSpawn());

    const resolved = await resolveClientDists({
      startDir: root,
      resolvePackage: resolvePackageThrows,
    });

    expect(resolved).toEqual({
      webDistDir: webDist,
      appDistDir: appDist,
      builtSha: fixtureHeadSha ?? "",
    });
    expect(bunCalls()).toHaveLength(0);
  });

  test("builds both missing bundles once and stamps the lockfile's app record", async () => {
    const { root, web, app } = seedCheckout();
    fixtureHeadSha = "a".repeat(40);
    // The stamp rides the edge's own record; a running edge is what's there.
    stampRootProcess("app", { pid: 4321, port: 7840 });
    const logSpy = spyOn(console, "log");
    spawnMock.mockImplementation(
      fakeSpawn(() => {
        seedWebDist(web);
        seedAppDist(app);
      }),
    );

    const resolved = await resolveClientDists({
      startDir: root,
      resolvePackage: resolvePackageThrows,
    });

    expect(resolved).toEqual({
      webDistDir: join(web, "dist"),
      appDistDir: join(app, "dist", "standalone"),
      builtSha: fixtureHeadSha ?? "",
    });
    const builds = bunCalls();
    expect(builds).toHaveLength(2);
    for (const [command, args] of builds) {
      expect(command).toBe("bun");
      expect(args).toEqual(["run", "build"]);
    }
    // The stamp is the commit both bundles consumed, recorded on the
    // lockfile's `app` entry.
    expect(readAppBuiltSha()).toBe(fixtureHeadSha);
    const rawLockfile = JSON.parse(
      readFileSync(
        join(process.env.XDG_CONFIG_HOME!, "cadet", "lockfile.json"),
        "utf-8",
      ),
    );
    expect(rawLockfile.app.builtSha).toBe(fixtureHeadSha);
    logSpy.mockRestore();

    // The second resolve finds a fresh stamp and does not rebuild.
    expect(
      await resolveClientDists({
        startDir: root,
        resolvePackage: resolvePackageThrows,
      }),
    ).toEqual(resolved);
    expect(bunCalls()).toHaveLength(2);
  });

  test("rebuilds both bundles when the checkout moved past the stamp", async () => {
    const { root, web, app } = seedCheckout();
    seedWebDist(web);
    seedAppDist(app);
    stampRootProcess("app", { pid: 4321, port: 7840 });
    stampAppBuiltSha("b".repeat(40));
    // The pull moved HEAD past the stamped build.
    fixtureHeadSha = "c".repeat(40);
    const logSpy = spyOn(console, "log");
    spawnMock.mockImplementation(fakeSpawn());

    const resolved = await resolveClientDists({
      startDir: root,
      resolvePackage: resolvePackageThrows,
    });

    expect(resolved.webDistDir).toBe(join(web, "dist"));
    expect(bunCalls()).toHaveLength(2);
    expect(
      logSpy.mock.calls.some((call) =>
        call.join(" ").includes("older than the current checkout"),
      ),
    ).toBe(true);
    logSpy.mockRestore();
    expect(readAppBuiltSha()).toBe(fixtureHeadSha);
  });

  test("serves fresh bundles without rebuilding", async () => {
    const { root, web, app } = seedCheckout();
    const webDist = seedWebDist(web);
    const appDist = seedAppDist(app);
    fixtureHeadSha = "d".repeat(40);
    stampRootProcess("app", { pid: 4321, port: 7840 });
    stampAppBuiltSha(fixtureHeadSha);
    spawnMock.mockImplementation(fakeSpawn());

    const resolved = await resolveClientDists({
      startDir: root,
      resolvePackage: resolvePackageThrows,
    });

    expect(resolved).toEqual({
      webDistDir: webDist,
      appDistDir: appDist,
      builtSha: fixtureHeadSha ?? "",
    });
    expect(bunCalls()).toHaveLength(0);
  });

  test("rebuilds bundles that predate the stamp once", async () => {
    const { root, web, app } = seedCheckout();
    seedWebDist(web);
    seedAppDist(app);
    fixtureHeadSha = "e".repeat(40);
    // The post-build stamp lands only on an existing edge record.
    stampRootProcess("app", { pid: 4321, port: 7840 });
    const logSpy = spyOn(console, "log");
    spawnMock.mockImplementation(fakeSpawn());

    const resolved = await resolveClientDists({
      startDir: root,
      resolvePackage: resolvePackageThrows,
    });

    expect(resolved.webDistDir).toBe(join(web, "dist"));
    expect(bunCalls()).toHaveLength(2);
    expect(
      logSpy.mock.calls.some((call) =>
        call.join(" ").includes("no build stamp"),
      ),
    ).toBe(true);
    logSpy.mockRestore();
    expect(readAppBuiltSha()).toBe(fixtureHeadSha);
  });

  test("returns null dists when there is no dist and no source package", async () => {
    const root = makeRoot();
    spawnMock.mockImplementation(unexpectedSpawn());

    const resolved = await resolveClientDists({
      startDir: root,
      resolvePackage: resolvePackageThrows,
    });

    expect(resolved).toEqual({
      webDistDir: null,
      appDistDir: null,
      builtSha: "",
    });
    expect(spawnMock.mock.calls).toHaveLength(0);
  });

  test("reports a failed source build with the manual recipe", async () => {
    const { root } = seedCheckout();
    fixtureHeadSha = "f".repeat(40);
    const logSpy = spyOn(console, "log");
    spawnMock.mockImplementation(fakeSpawn(undefined, 1));

    await expect(
      resolveClientDists({
        startDir: root,
        resolvePackage: resolvePackageThrows,
      }),
    ).rejects.toThrow("cd clients/web && bun run build");
    logSpy.mockRestore();
  });

  test("records the stamp only after both builds succeed", async () => {
    const { root, web } = seedCheckout();
    fixtureHeadSha = "1".repeat(40);
    let builds = 0;
    spawnMock.mockImplementation(((command: string) => {
      if (command === "git") {
        return fakeGitChild();
      }
      builds++;
      const child = new childProcess.ChildProcess();
      // The web build lands; the app build fails — a half-stamped state must
      // never pretend the second bundle is fresh.
      if (builds === 1) {
        seedWebDist(web);
        setTimeout(() => child.emit("exit", 0), 10);
      } else {
        setTimeout(() => child.emit("exit", 1), 10);
      }
      return child;
    }) as unknown as typeof childProcess.spawn);

    await expect(
      resolveClientDists({
        startDir: root,
        resolvePackage: resolvePackageThrows,
      }),
    ).rejects.toThrow("Building the app bundle from source failed");

    expect(readAppBuiltSha()).toBeUndefined();
  });

  test("leaves installed-package dists alone even with a stale source checkout", async () => {
    const { root, web, app } = seedCheckout();
    // The npm arm resolves first and owns the web dist; the source checkout
    // may be as stale as it likes.
    const npmWebDir = join(root, "npm", "@mycadet", "web");
    seedWebDist(npmWebDir);
    const appDist = seedAppDist(app);
    seedWebDist(web);
    fixtureHeadSha = "2".repeat(40);
    // The source-built app arm is fresh at HEAD, so nothing rebuilds.
    stampRootProcess("app", { pid: 4321, port: 7840 });
    stampAppBuiltSha(fixtureHeadSha);
    spawnMock.mockImplementation(((command: string) => {
      // git HEAD is a legitimate probe (the app arm is source-built); a
      // BUILD spawn here is a bug.
      if (command === "git") {
        return fakeGitChild();
      }
      throw new Error("unexpected spawn");
    }) as unknown as typeof childProcess.spawn);

    const resolved = await resolveClientDists({
      startDir: root,
      resolvePackage: () => join(npmWebDir, "package.json"),
    });

    expect(resolved).toEqual({
      webDistDir: join(npmWebDir, "dist"),
      appDistDir: appDist,
      builtSha: fixtureHeadSha ?? "",
    });
    expect(bunCalls()).toHaveLength(0);
  });
});
