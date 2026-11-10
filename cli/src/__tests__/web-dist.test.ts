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
  rmSync(webDistDir(), { recursive: true, force: true });
  rmSync(appDistDir(), { recursive: true, force: true });
});

afterAll(() => {
  for (const dir of lockfileDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The dist resolution has no injected start dir anymore — the source arm
 * walks up from the CLI module's own directory, so the fixtures are the real
 * checkout's (gitignored) build outputs, written and wiped per test.
 */
const worktreeRoot = join(import.meta.dir, "..", "..", "..");
const webPackageDir = join(worktreeRoot, "clients", "web");
const appPackageDir = join(worktreeRoot, "clients", "app");

function webDistDir(): string {
  return join(webPackageDir, "dist");
}

function appDistDir(): string {
  return join(appPackageDir, "dist", "standalone");
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
    // The real build spawn pipes both streams (the resolve captures the
    // output and stays silent); the fake mirrors that shape.
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    Object.defineProperty(child, "stdout", { value: stdout });
    Object.defineProperty(child, "stderr", { value: stderr });
    setTimeout(() => {
      stdout.end();
      stderr.end();
      child.emit("exit", bunCode);
    }, 10);
    return child;
  }) as unknown as typeof childProcess.spawn;
}

function bunCalls(): Array<Parameters<typeof childProcess.spawn>> {
  return spawnMock.mock.calls.filter(([command]) => command === "bun") as Array<
    Parameters<typeof childProcess.spawn>
  >;
}

function seedWebDist(): string {
  mkdirSync(webDistDir(), { recursive: true });
  writeFileSync(join(webDistDir(), "index.html"), "<html></html>");
  return webDistDir();
}

function seedAppDist(): string {
  mkdirSync(appDistDir(), { recursive: true });
  writeFileSync(join(appDistDir(), "index.html"), "<html></html>");
  return appDistDir();
}

describe("resolveClientDists", () => {
  test("builds both missing bundles once and stamps the lockfile's app record", async () => {
    fixtureHeadSha = "a".repeat(40);
    // The stamp rides the edge's own record; a running edge is what's there.
    stampRootProcess("app", { pid: 4321, port: 7840 });
    const logSpy = spyOn(console, "log");
    spawnMock.mockImplementation(
      fakeSpawn(() => {
        seedWebDist();
        seedAppDist();
      }),
    );

    const resolved = await resolveClientDists();

    expect(resolved).toEqual({
      webDistDir: webDistDir(),
      appDistDir: appDistDir(),
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
    expect(await resolveClientDists()).toEqual(resolved);
    expect(bunCalls()).toHaveLength(2);
  });

  test("rebuilds both bundles when the checkout moved past the stamp", async () => {
    seedWebDist();
    seedAppDist();
    stampRootProcess("app", { pid: 4321, port: 7840 });
    stampAppBuiltSha("b".repeat(40));
    // The pull moved HEAD past the stamped build.
    fixtureHeadSha = "c".repeat(40);
    const logSpy = spyOn(console, "log");
    spawnMock.mockImplementation(fakeSpawn());

    const resolved = await resolveClientDists();

    expect(resolved.webDistDir).toBe(webDistDir());
    expect(bunCalls()).toHaveLength(2);
    // The rebuild is silent apart from the two bookend lines — the build
    // output itself is captured (surfacing only on failure).
    expect(
      logSpy.mock.calls.some((call) =>
        call.join(" ").includes("Building app client..."),
      ),
    ).toBe(true);
    expect(
      logSpy.mock.calls.some((call) =>
        call.join(" ").includes("web client built."),
      ),
    ).toBe(true);
    logSpy.mockRestore();
    expect(readAppBuiltSha()).toBe(fixtureHeadSha);
  });

  test("serves fresh bundles without rebuilding", async () => {
    const webDist = seedWebDist();
    const appDist = seedAppDist();
    fixtureHeadSha = "d".repeat(40);
    stampRootProcess("app", { pid: 4321, port: 7840 });
    stampAppBuiltSha(fixtureHeadSha);
    spawnMock.mockImplementation(fakeSpawn());

    const resolved = await resolveClientDists();

    expect(resolved).toEqual({
      webDistDir: webDist,
      appDistDir: appDist,
      builtSha: fixtureHeadSha ?? "",
    });
    expect(bunCalls()).toHaveLength(0);
  });

  test("rebuilds bundles that predate the stamp once", async () => {
    seedWebDist();
    seedAppDist();
    fixtureHeadSha = "e".repeat(40);
    // The post-build stamp lands only on an existing edge record.
    stampRootProcess("app", { pid: 4321, port: 7840 });
    const logSpy = spyOn(console, "log");
    spawnMock.mockImplementation(fakeSpawn());

    const resolved = await resolveClientDists();

    expect(resolved.webDistDir).toBe(webDistDir());
    expect(bunCalls()).toHaveLength(2);
    expect(
      logSpy.mock.calls.some((call) =>
        call.join(" ").includes("Building app client..."),
      ),
    ).toBe(true);
    expect(
      logSpy.mock.calls.some((call) =>
        call.join(" ").includes("web client built."),
      ),
    ).toBe(true);
    logSpy.mockRestore();
    expect(readAppBuiltSha()).toBe(fixtureHeadSha);
  });

  test("reports a failed source build with the captured output", async () => {
    fixtureHeadSha = "f".repeat(40);
    const logSpy = spyOn(console, "log");
    spawnMock.mockImplementation(fakeSpawn(undefined, 1));

    await expect(resolveClientDists()).rejects.toThrow(
      "the app bundle failed to build",
    );
    logSpy.mockRestore();
  });

  test("records the stamp only after both builds succeed", async () => {
    fixtureHeadSha = "1".repeat(40);
    let builds = 0;
    spawnMock.mockImplementation(((command: string) => {
      if (command === "git") {
        return fakeGitChild();
      }
      builds++;
      const child = new childProcess.ChildProcess();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      Object.defineProperty(child, "stdout", { value: stdout });
      Object.defineProperty(child, "stderr", { value: stderr });
      // The app build lands; the web build fails — a half-stamped state
      // must never pretend the second bundle is fresh.
      if (builds === 1) {
        seedAppDist();
        setTimeout(() => {
          stdout.end();
          stderr.end();
          child.emit("exit", 0);
        }, 10);
      } else {
        setTimeout(() => {
          stdout.end();
          stderr.end();
          child.emit("exit", 1);
        }, 10);
      }
      return child;
    }) as unknown as typeof childProcess.spawn);

    await expect(resolveClientDists()).rejects.toThrow(
      "the web bundle failed to build",
    );

    expect(readAppBuiltSha()).toBeUndefined();
  });
});
