import { type PathLike, type StatsFs } from "node:fs";
import { promisify } from "node:util";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

let existingPaths = new Set<string>();
// The preload gives every test process a real temp workspace; tests that
// simulate filesystem state inject it through setDiskUsageFsForTesting.
const workspaceDir = process.env.VELLUM_WORKSPACE_DIR!;
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

const {
  __resetDiskUsageCacheForTests,
  getDiskUsageInfo,
  parseK8sMemoryBytes,
  setDiskUsageFsForTesting,
} = await import("../util/disk-usage.js");

afterAll(() => {
  setDiskUsageFsForTesting(null);
  delete process.env.VELLUM_MINIKUBE_STORAGE_SIZE;
  delete process.env.IS_CONTAINERIZED;
  delete process.env.IS_PLATFORM;
});

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
    delete process.env.VELLUM_MINIKUBE_STORAGE_SIZE;
    delete process.env.IS_CONTAINERIZED;
    delete process.env.IS_PLATFORM;
    statfsResult = statfsFor(100 * MIB, 25 * MIB);
    setDiskUsageFsForTesting({
      existsSync: (path: PathLike) => existingPaths.has(String(path)),
      statfsSync: () => statfsResult as unknown as StatsFs,
    });
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
    process.env.VELLUM_MINIKUBE_STORAGE_SIZE = "1Gi";
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
    process.env.VELLUM_MINIKUBE_STORAGE_SIZE = "1Gi";
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
    process.env.IS_CONTAINERIZED = "1";
    delete process.env.IS_PLATFORM;
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
    process.env.IS_CONTAINERIZED = "1";
    process.env.IS_PLATFORM = "1";
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
    process.env.IS_CONTAINERIZED = "1";
    delete process.env.IS_PLATFORM;
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
    process.env.VELLUM_MINIKUBE_STORAGE_SIZE = "1Gi";
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
