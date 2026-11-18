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
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import {
  findSourcePackageDir,
  resolveClientDists,
} from "../lib/web-dist.js";

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

/** The fingerprint stamp web-dist writes inside each dist it builds. */
const STAMP_FILENAME = ".cadet-source-sha";

function distStamp(distDir: string): string {
  return readFileSync(join(distDir, STAMP_FILENAME), "utf-8");
}

/** A stamp value no real source hash can equal — forces the stale branch. */
const STALE_STAMP = `${"b".repeat(64)}\n`;

afterEach(() => {
  spawnMock.mockReset();
  spawnMock.mockImplementation(realChildProcess.spawn);
  rmSync(webDistDir(), { recursive: true, force: true });
  rmSync(appDistDir(), { recursive: true, force: true });
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

/**
 * The process-boundary fake: bun spawns run the fake build — optionally
 * "landing" the bundle files where the real build would write them — then
 * exit with the given code.
 */
function fakeSpawn(
  landBun?: () => void,
  bunCode = 0,
): typeof childProcess.spawn {
  return (() => {
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

describe("resolveClientDists", () => {
  test("builds both missing bundles once and stamps each dist directory", async () => {
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
    });
    const builds = bunCalls();
    expect(builds).toHaveLength(2);
    for (const [command, args] of builds) {
      expect(command).toBe("bun");
      expect(args).toEqual(["run", "build"]);
    }
    // The stamp is the fingerprint the bundle's own source hashed to,
    // recorded in the dist itself — a hex source hash, not a git sha (a
    // git-less checkout still stamps).
    for (const dist of [webDistDir(), appDistDir()]) {
      expect(distStamp(dist)).toMatch(/^[0-9a-f]{64}\n$/);
    }
    logSpy.mockRestore();

    // The second resolve finds fresh stamps and does not rebuild — even with
    // spawns rigged to fail, proving nothing tries to build.
    spawnMock.mockImplementation(fakeSpawn(undefined, 1));
    expect(await resolveClientDists()).toEqual(resolved);
    expect(bunCalls()).toHaveLength(2);
  });

  test("rebuilds both bundles when a dist's stamp disagrees with the source", async () => {
    seedWebDist();
    seedAppDist();
    writeFileSync(join(webDistDir(), STAMP_FILENAME), STALE_STAMP);
    writeFileSync(join(appDistDir(), STAMP_FILENAME), STALE_STAMP);
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
    // The stale stamp is replaced by the checkout's own fingerprint.
    expect(distStamp(appDistDir())).not.toBe(STALE_STAMP);
    expect(distStamp(webDistDir())).not.toBe(STALE_STAMP);
  });

  test("rebuilds a dist that predates stamping once (pre-stamp bootstrap)", async () => {
    seedWebDist();
    seedAppDist();
    const logSpy = spyOn(console, "log");
    spawnMock.mockImplementation(fakeSpawn());

    const resolved = await resolveClientDists();

    expect(resolved.webDistDir).toBe(webDistDir());
    expect(bunCalls()).toHaveLength(2);
    logSpy.mockRestore();
    expect(distStamp(appDistDir())).toMatch(/^[0-9a-f]{64}\n$/);
  });

  test("reports a failed source build with the captured output", async () => {
    const logSpy = spyOn(console, "log");
    spawnMock.mockImplementation(fakeSpawn(undefined, 1));

    await expect(resolveClientDists()).rejects.toThrow(
      "the app bundle failed to build",
    );
    logSpy.mockRestore();
  });

  test("stamps each dist as its own build lands, never for a failed one", async () => {
    let builds = 0;
    spawnMock.mockImplementation((() => {
      builds++;
      const child = new childProcess.ChildProcess();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      Object.defineProperty(child, "stdout", { value: stdout });
      Object.defineProperty(child, "stderr", { value: stderr });
      // The app build lands; the web build fails — the half-resolved state
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

    // The app dist carries its own stamp; the web dist has none and reads
    // stale on the next resolve.
    expect(distStamp(appDistDir())).toMatch(/^[0-9a-f]{64}\n$/);
    expect(() => distStamp(webDistDir())).toThrow();
  });
});

describe("findSourcePackageDir", () => {
  // The installed-package arm: `@mycadet/<kind>` lands at
  // `node_modules/@mycadet/<kind>` — an ancestor's `<kind>/package.json`.
  // Its published manifest strips scripts, so it must never read as the
  // checkout arm (the dev-release "Script not found 'build'" startup
  // failure was exactly this misclassification).
  test("classifies an installed @mycadet package as the non-checkout arm", () => {
    const root = mkdtempSync(join(tmpdir(), "web-dist-arm-"));
    const appPackage = join(root, "node_modules", "@mycadet", "app");
    mkdirSync(join(appPackage, "dist", "standalone"), { recursive: true });
    writeFileSync(
      join(appPackage, "package.json"),
      JSON.stringify({ name: "@mycadet/app", version: "0.0.0" }),
    );
    writeFileSync(join(appPackage, "dist", "standalone", "index.html"), "<html></html>");
    try {
      const found = findSourcePackageDir(
        "app",
        join(root, "node_modules", "@mycadet", "cli", "src", "lib"),
      );
      expect(found?.dir).toBe(appPackage);
      expect(found?.isCheckout).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("classifies the repo checkout as the checkout arm", () => {
    const root = mkdtempSync(join(tmpdir(), "web-dist-arm-"));
    const appPackage = join(root, "clients", "app");
    mkdirSync(appPackage, { recursive: true });
    writeFileSync(
      join(appPackage, "package.json"),
      JSON.stringify({ name: "@mycadet/app", scripts: { build: "true" } }),
    );
    try {
      const found = findSourcePackageDir(
        "app",
        join(root, "cli", "src", "lib"),
      );
      expect(found?.dir).toBe(appPackage);
      expect(found?.isCheckout).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
