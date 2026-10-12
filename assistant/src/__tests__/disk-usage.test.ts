import { statfsSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";

const PRELOAD_WS = process.env.CADET_WORKSPACE_DIR!;
const MIB = 1024 * 1024;
const round2 = (b: number) => Math.round((b / MIB) * 100) / 100;

interface StatfsSnapshot {
  total: number;
  free: number;
}

function statfsSnapshot(path: string): StatfsSnapshot {
  const stats = statfsSync(path);
  return {
    total: Number(stats.bsize) * Number(stats.blocks),
    free: Number(stats.bsize) * Number(stats.bavail),
  };
}

// statfs on a loaded CI runner drifts between any two reads — 8 parallel
// test processes write /tmp constantly, so used/free shift by rounding steps
// between the test's snapshot and the sampler's own. Equality against a
// pre-call snapshot therefore races (run 37543239704). Assert instead that
// the sampler's numbers fall inside the [before, after] snapshot window.
function expectWithinStatfsWindow(
  usage: { path: string; totalMb: number; usedMb: number; freeMb: number },
  path: string,
  before: StatfsSnapshot,
  after: StatfsSnapshot,
): void {
  const totalLo = round2(Math.min(before.total, after.total));
  const totalHi = round2(Math.max(before.total, after.total));
  const freeLo = round2(Math.min(before.free, after.free));
  const freeHi = round2(Math.max(before.free, after.free));
  // used = total - free at the sampler's read time; both operands drift.
  const usedLo =
    round2(
      Math.min(before.total, after.total) - Math.max(before.free, after.free),
    ) - 0.01;
  const usedHi =
    round2(
      Math.max(before.total, after.total) - Math.min(before.free, after.free),
    ) + 0.01;
  expect(usage.path).toBe(path);
  expect(usage.totalMb).toBeGreaterThanOrEqual(totalLo - 0.01);
  expect(usage.totalMb).toBeLessThanOrEqual(totalHi + 0.01);
  expect(usage.freeMb).toBeGreaterThanOrEqual(freeLo - 0.01);
  expect(usage.freeMb).toBeLessThanOrEqual(freeHi + 0.01);
  expect(usage.usedMb).toBeGreaterThanOrEqual(usedLo);
  expect(usage.usedMb).toBeLessThanOrEqual(usedHi);
}

const { getDiskUsageInfo, parseK8sMemoryBytes } =
  await import("../util/disk-usage.js");

const ENV_VARS = [
  "CADET_MINIKUBE_STORAGE_SIZE",
  "IS_CONTAINERIZED",
  "IS_CLOUD",
] as const;

function clearEnvironment(): void {
  for (const name of ENV_VARS) {
    delete process.env[name];
  }
  process.env.CADET_WORKSPACE_DIR = PRELOAD_WS;
}

afterAll(clearEnvironment);

async function expectFilesystemUsage(): Promise<void> {
  const before = statfsSnapshot(PRELOAD_WS);
  const usage = await getDiskUsageInfo();
  const after = statfsSnapshot(PRELOAD_WS);
  expect(usage).not.toBeNull();
  expectWithinStatfsWindow(usage!, PRELOAD_WS, before, after);
}

describe("disk usage sampler", () => {
  beforeEach(clearEnvironment);

  test("reports real filesystem usage", expectFilesystemUsage);

  test("falls back to root when the workspace path does not exist", async () => {
    process.env.CADET_WORKSPACE_DIR = "/tmp/does-not-exist-disk-usage-test";
    try {
      expect((await getDiskUsageInfo())?.path).toBe("/");
    } finally {
      process.env.CADET_WORKSPACE_DIR = PRELOAD_WS;
    }
  });

  test("reports the backing filesystem rather than a minikube quota", async () => {
    process.env.CADET_MINIKUBE_STORAGE_SIZE = "1Mi";
    await expectFilesystemUsage();
  });

  test("reports the backing filesystem for local Docker volumes", async () => {
    process.env.IS_CONTAINERIZED = "1";
    await expectFilesystemUsage();
  });

  test("reports filesystem usage for cloud-managed containers", async () => {
    process.env.IS_CONTAINERIZED = "1";
    process.env.IS_CLOUD = "1";
    await expectFilesystemUsage();
  });

  test("returns null for malformed Kubernetes memory strings", () => {
    for (const value of ["", "abc", "12Zi", "-1Gi", "0Gi"]) {
      expect(parseK8sMemoryBytes(value)).toBeNull();
    }
  });
});
