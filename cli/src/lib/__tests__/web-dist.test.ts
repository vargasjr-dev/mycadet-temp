import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findWebDistDir, readWebReleaseVersion } from "../web-dist.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cadet-web-dist-"));
  tempDirs.push(dir);
  return dir;
}

function writeWebDist(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), "<!doctype html>", "utf8");
}

const missingPackage = (): string => {
  throw new Error("package missing");
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("finds web assets beside a packaged Windows CLI", () => {
  const root = makeTempDir();
  const runtimeDir = join(root, "runtime");
  const webDistDir = join(runtimeDir, "web-dist");
  writeWebDist(webDistDir);

  expect(
    findWebDistDir({
      execPath: join(runtimeDir, "cadet.exe"),
      platform: "win32",
      resolvePackage: missingPackage,
      startDir: join(root, "source"),
    }),
  ).toBe(webDistDir);
});

test("does not use the Windows runtime path on macOS", () => {
  const root = makeTempDir();
  const runtimeDir = join(root, "runtime");
  writeWebDist(join(runtimeDir, "web-dist"));

  expect(
    findWebDistDir({
      execPath: join(runtimeDir, "cadet"),
      platform: "darwin",
      resolvePackage: missingPackage,
      startDir: join(root, "source"),
    }),
  ).toBeNull();
});

test("preserves installed package and source checkout resolution", () => {
  const root = makeTempDir();
  const packageDir = join(root, "package");
  const packageDist = join(packageDir, "dist");
  writeWebDist(packageDist);
  writeFileSync(join(packageDir, "package.json"), "{}", "utf8");

  expect(
    findWebDistDir({
      platform: "linux",
      resolvePackage: () => join(packageDir, "package.json"),
      startDir: join(root, "missing-source"),
    }),
  ).toBe(packageDist);

  const sourceDist = join(root, "repo", "clients", "web", "dist");
  writeWebDist(sourceDist);
  expect(
    findWebDistDir({
      platform: "linux",
      resolvePackage: missingPackage,
      startDir: join(root, "repo", "cli", "src"),
    }),
  ).toBe(sourceDist);
});

test("reads the built UI release, including a normalized version prefix", () => {
  const root = makeTempDir();
  writeFileSync(
    join(root, "release.json"),
    JSON.stringify({ version: "v1.2.3-dev.5" }),
  );
  expect(readWebReleaseVersion(root)).toBe("1.2.3-dev.5");
});

test("missing or malformed release metadata cannot stand in for a release", () => {
  const root = makeTempDir();
  expect(readWebReleaseVersion(root)).toBeUndefined();
  for (const value of [
    "not JSON",
    "null",
    "{}",
    '{"version":null}',
    '{"version":"latest"}',
    '{"version":""}',
    '{"version":"bundle-hash"}',
  ]) {
    writeFileSync(join(root, "release.json"), value);
    expect(readWebReleaseVersion(root)).toBeUndefined();
  }
});
