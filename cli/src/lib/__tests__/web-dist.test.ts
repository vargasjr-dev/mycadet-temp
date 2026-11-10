import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findWebDistDir } from "../web-dist.js";

/**
 * The seams are the process now: the packaged arm reads `process.platform`
 * and `process.execPath` directly, and the source arm walks up from the
 * module's own directory — so the packaged arm is reached by mutating the
 * process surface for the duration of a test, and the source arm by writing
 * the checkout's own (gitignored) `clients/web/dist`.
 */
const worktreeRoot = join(import.meta.dir, "..", "..", "..");
const realWebDistDir = join(worktreeRoot, "clients", "web", "dist");

const savedPlatforms: NodeJS.Platform[] = [];
const savedExecPaths: string[] = [];

function setPlatform(platform: NodeJS.Platform): void {
  savedPlatforms.push(process.platform);
  Object.defineProperty(process, "platform", { value: platform });
}

function setExecPath(execPath: string): void {
  savedExecPaths.push(process.execPath);
  process.execPath = execPath;
}

afterEach(() => {
  if (savedPlatforms.length) {
    Object.defineProperty(process, "platform", { value: savedPlatforms.pop() });
  }
  if (savedExecPaths.length) {
    process.execPath = savedExecPaths.pop()!;
  }
  rmSync(realWebDistDir, { recursive: true, force: true });
});

function writeWebDist(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), "<!doctype html>", "utf8");
}

test("finds web assets beside a packaged Windows CLI", () => {
  const runtimeDir = join(tmpdir(), "cadet-web-dist-runtime");
  const webDistDir = join(runtimeDir, "web-dist");
  writeWebDist(webDistDir);
  setPlatform("win32");
  setExecPath(join(runtimeDir, "cadet.exe"));

  expect(findWebDistDir()).toBe(webDistDir);

  rmSync(runtimeDir, { recursive: true, force: true });
});

test("does not use the Windows runtime path on macOS", () => {
  const runtimeDir = join(tmpdir(), "cadet-web-dist-runtime");
  writeWebDist(join(runtimeDir, "web-dist"));
  setPlatform("darwin");
  setExecPath(join(runtimeDir, "cadet"));

  expect(findWebDistDir()).toBeNull();

  rmSync(runtimeDir, { recursive: true, force: true });
});

test("the source arm walks up from the CLI's own directory", () => {
  writeWebDist(realWebDistDir);
  expect(findWebDistDir()).toBe(realWebDistDir);

  rmSync(realWebDistDir, { recursive: true, force: true });
  expect(findWebDistDir()).toBeNull();
});
