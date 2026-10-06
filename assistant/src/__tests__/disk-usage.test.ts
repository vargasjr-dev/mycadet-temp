import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeEach, describe, expect, mock, test } from "bun:test";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

let existingPaths = new Set<string>();
// The real getWorkspaceDir() reads VELLUM_WORKSPACE_DIR at call time — a real
// tmp dir keeps the ephemeral-path guard happy while the test controls
// existsSync/statfsSync through the node:fs mock.
const workspaceDir = mkdtempSync(join(tmpdir(), "disk-usage-test-"));
process.env.VELLUM_WORKSPACE_DIR = workspaceDir;
let minikubeStorageSize: string | undefined;
let isContainerized = false;
let isPlatform = false;
let statfsResult = {
  bsize: 4096,
  blocks: 0,
  bavail: 0,
};
let spawnResult: {
  status: number | null;
  stdout: string;
} = {
  status: 0,
  stdout: "",
};
let spawnCalls: Array<{ command: string; args: string[] }> = [];

// Spread the actual node:fs so the real util/platform.ts (no longer mocked)
// keeps working with mkdirSync/chmodSync, while the disk-usage module's
// existsSync/statfsSync stay stubbed.
const actualFs = await import("node:fs");
mock.module("node:fs", () => ({
  ...actualFs,
  existsSync: (path: string) => existingPaths.has(path),
  statfsSync: () => statfsResult,
}));

// The module under test calls `promisify(execFile)`, so the mock only needs
// to provide the promisified implementation via the promisify.custom symbol.
const execFileMock = Object.assign(
  () => {
    throw new Error("callback-style execFile is not used by disk-usage");
  },
  {
    [promisify.custom]: async (command: string, args: string[]) => {
      spawnCalls.push({ command, args });
      if (spawnResult.status !== 0) {
        throw new Error(`Command failed with exit code ${spawnResult.status}`);
      }
      return { stdout: spawnResult.stdout, stderr: "" };
    },
  },
);

mock.module("node:child_process", () => ({
  execFile: execFileMock,
}));

// Spread the actual module so the real util/platform.ts (no longer mocked)
// keeps finding getWorkspaceDirOverride on the mocked env-registry.
const actualEnvRegistry = await import("../config/env-registry.js");
mock.module("../config/env-registry.js", () => ({
  ...actualEnvRegistry,
  getMinikubeStorageSize: () => minikubeStorageSize,
  getIsContainerized: () => isContainerized,
  getIsPlatform: () => isPlatform,
}));

const { __resetDiskUsageCacheForTests, getDiskUsageInfo, parseK8sMemoryBytes } =
  await import("../util/disk-usage.js");

function statfsFor(totalBytes: number, freeBytes: number) {
  return {
    bsize: MIB,
    blocks: totalBytes / MIB,
    bavail: freeBytes / MIB,
  };
}

describe("disk usage sampler", () => {
  beforeEach(() => {
    existingPaths = new Set([workspaceDir]);
    minikubeStorageSize = undefined;
    isContainerized = false;
    isPlatform = false;
    statfsResult = statfsFor(100 * MIB, 25 * MIB);
    spawnResult = { status: 0, stdout: "" };
    spawnCalls = [];
    __resetDiskUsageCacheForTests();
  });

  test("reports regular statfs usage", async () => {
    const usage = await getDiskUsageInfo();

    expect(usage).toEqual({
      path: workspaceDir,
      totalMb: 100,
      usedMb: 75,
      freeMb: 25,
    });
    expect(spawnCalls).toHaveLength(0);
  });

  test("falls back to root when the workspace path does not exist", async () => {
    existingPaths = new Set();

    const usage = await getDiskUsageInfo();

    expect(usage?.path).toBe("/");
  });

  test("uses PVC capacity and du usage when host filesystem is larger", async () => {
    minikubeStorageSize = "1Gi";
    statfsResult = statfsFor(10 * GIB, 8 * GIB);
    spawnResult = {
      status: 0,
      stdout: `${100 * MIB}\t${workspaceDir}\n`,
    };

    const usage = await getDiskUsageInfo();

    expect(usage).toEqual({
      path: workspaceDir,
      totalMb: 1024,
      usedMb: 100,
      freeMb: 924,
    });
    expect(spawnCalls).toEqual([
      { command: "du", args: ["-sb", workspaceDir] },
    ]);
  });

  test("includes /data in PVC du usage when it exists separately", async () => {
    existingPaths = new Set([workspaceDir, "/data"]);
    minikubeStorageSize = "1Gi";
    statfsResult = statfsFor(10 * GIB, 8 * GIB);
    spawnResult = {
      status: 0,
      stdout: `${100 * MIB}\t${workspaceDir}\n${20 * MIB}\t/data\n`,
    };

    const usage = await getDiskUsageInfo();

    expect(usage?.usedMb).toBe(120);
    expect(spawnCalls).toEqual([
      { command: "du", args: ["-sb", workspaceDir, "/data"] },
    ]);
  });

  test("measures workspace du usage on a local Docker hatch", async () => {
    isContainerized = true;
    isPlatform = false;
    statfsResult = statfsFor(100 * GIB, 40 * GIB);
    spawnResult = {
      status: 0,
      stdout: `${2 * GIB}\t${workspaceDir}\n`,
    };

    const usage = await getDiskUsageInfo();

    // Used reflects only the workspace (du), free reflects the host headroom
    // the volume can grow into, and total is their sum.
    expect(usage).toEqual({
      path: workspaceDir,
      totalMb: 2048 + 40960,
      usedMb: 2048,
      freeMb: 40960,
    });
    expect(spawnCalls).toEqual([
      { command: "du", args: ["-sb", workspaceDir] },
    ]);
  });

  test("does not use du for platform-managed containerized instances", async () => {
    isContainerized = true;
    isPlatform = true;
    statfsResult = statfsFor(10 * GIB, 6 * GIB);

    const usage = await getDiskUsageInfo();

    expect(usage).toEqual({
      path: workspaceDir,
      totalMb: 10240,
      usedMb: 4096,
      freeMb: 6144,
    });
    expect(spawnCalls).toHaveLength(0);
  });

  test("falls back to statfs when du fails on a local Docker hatch", async () => {
    isContainerized = true;
    isPlatform = false;
    statfsResult = statfsFor(100 * GIB, 40 * GIB);
    spawnResult = { status: 1, stdout: "" };

    const usage = await getDiskUsageInfo();

    expect(usage).toEqual({
      path: workspaceDir,
      totalMb: 102400,
      usedMb: 61440,
      freeMb: 40960,
    });
    expect(spawnCalls).toEqual([
      { command: "du", args: ["-sb", workspaceDir] },
    ]);
  });

  test("returns null for malformed Kubernetes memory strings", () => {
    expect(parseK8sMemoryBytes("")).toBeNull();
    expect(parseK8sMemoryBytes("abc")).toBeNull();
    expect(parseK8sMemoryBytes("12Zi")).toBeNull();
    expect(parseK8sMemoryBytes("-1Gi")).toBeNull();
    expect(parseK8sMemoryBytes("0Gi")).toBeNull();
  });

  test("falls back to statfs when du fails in PVC mode", async () => {
    minikubeStorageSize = "1Gi";
    statfsResult = statfsFor(10 * GIB, 8 * GIB);
    spawnResult = {
      status: 1,
      stdout: "",
    };

    const usage = await getDiskUsageInfo();

    expect(usage).toEqual({
      path: workspaceDir,
      totalMb: 10240,
      usedMb: 2048,
      freeMb: 8192,
    });
    expect(spawnCalls).toEqual([
      { command: "du", args: ["-sb", workspaceDir] },
    ]);
  });
});
