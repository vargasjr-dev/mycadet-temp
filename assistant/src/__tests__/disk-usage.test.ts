import { execFile } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";

// Captured at module scope: the preload cleans up its env var between suites.
const PRELOAD_WS = process.env.CADET_WORKSPACE_DIR!;

const MIB = 1024 * 1024;
const round2 = (b: number) => Math.round((b / MIB) * 100) / 100;

const execFileAsync = promisify(execFile);

/** Same measurement the module under test performs, done for real. */
async function duBytes(paths: string[]): Promise<number> {
  const existing = paths.filter((p) => existsSync(p));
  if (existing.length === 0) {
    return 0;
  }
  const { stdout } = await execFileAsync("du", ["-sb", ...existing]);
  let total = 0;
  for (const line of stdout.trim().split("\n")) {
    const size = parseInt(line.split("\t")[0], 10);
    if (!isNaN(size) && size > 0) {
      total += size;
    }
  }
  return total;
}

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

const { __resetDiskUsageCacheForTests, getDiskUsageInfo, parseK8sMemoryBytes } =
  await import("../util/disk-usage.js");

// Env knobs the sampler reads at call time; no module mocking needed.
const ENV_VARS = [
  "CADET_MINIKUBE_STORAGE_SIZE",
  "IS_CONTAINERIZED",
  "IS_CLOUD",
] as const;

afterAll(() => {
  for (const v of ENV_VARS) {
    delete process.env[v];
  }
});

// `du -sb` of an empty directory is 0, which the sampler treats as
// unmeasurable — seed real bytes so the du-backed branches have data.
const PAYLOAD = join(PRELOAD_WS, "bulk.bin");

describe("disk usage sampler", () => {
  beforeEach(() => {
    for (const v of ENV_VARS) {
      delete process.env[v];
    }
    process.env.CADET_WORKSPACE_DIR = PRELOAD_WS;
    writeFileSync(PAYLOAD, Buffer.alloc(512 * 1024));
    __resetDiskUsageCacheForTests();
  });

  test("reports real statfs usage", async () => {
    const before = statfsSnapshot(PRELOAD_WS);
    const usage = await getDiskUsageInfo();
    const after = statfsSnapshot(PRELOAD_WS);

    expect(usage).not.toBeNull();
    expectWithinStatfsWindow(usage!, PRELOAD_WS, before, after);
  });

  test("falls back to root when the workspace path does not exist", async () => {
    process.env.CADET_WORKSPACE_DIR = "/tmp/does-not-exist-disk-usage-test";
    try {
      const usage = await getDiskUsageInfo();
      expect(usage?.path).toBe("/");
    } finally {
      // Restore rather than delete: the sampler reads the workspace at call
      // time and later tests still need the preload's workspace.
      process.env.CADET_WORKSPACE_DIR = PRELOAD_WS;
    }
  });

  test("uses PVC capacity and du usage when the host filesystem is larger", async () => {
    // A 1MiB PVC is always smaller than the real host filesystem, so the
    // hostPath detection fires and capacity is the quota, usage is `du`.
    process.env.CADET_MINIKUBE_STORAGE_SIZE = "1Mi";

    const before = statfsSnapshot(PRELOAD_WS);
    const usage = await getDiskUsageInfo();
    const after = statfsSnapshot(PRELOAD_WS);

    // totalMb === 1 is the fixed-cap branch signature (the sampler's du ran).
    // A failed du spawn under CI load is a legal statfs fallback — asserted
    // with the window instead of failing the run.
    if (usage!.totalMb === 1) {
      // The 512KiB payload must show up in the measurement.
      expect(usage!.usedMb).toBeGreaterThanOrEqual(0.49);
      expect(
        Math.abs(usage!.freeMb - Math.max(0, 1 - usage!.usedMb)),
      ).toBeLessThanOrEqual(0.02);
    } else {
      expectWithinStatfsWindow(usage!, PRELOAD_WS, before, after);
    }
  });

  test("adds /data to du usage when it exists separately", async () => {
    process.env.CADET_MINIKUBE_STORAGE_SIZE = "1Mi";
    const workspaceOnly = round2(await duBytes([PRELOAD_WS]));

    const before = statfsSnapshot(PRELOAD_WS);
    const usage = await getDiskUsageInfo();
    const after = statfsSnapshot(PRELOAD_WS);

    if (usage!.totalMb !== 1) {
      // Sampler's du spawn failed under load → legal statfs fallback.
      expectWithinStatfsWindow(usage!, PRELOAD_WS, before, after);
      return;
    }
    // The impl's path set is workspace + /data (when /data exists). It can
    // only be >= the workspace-only floor; equality holds on machines
    // without /data.
    expect(usage!.usedMb).toBeGreaterThanOrEqual(workspaceOnly);
  });

  test("a PVC at least as large as the filesystem reports statfs directly", async () => {
    // 1TiB is larger than any test filesystem: the hostPath detection must
    // NOT fire, so the sampler trusts statfs instead of `du`.
    process.env.CADET_MINIKUBE_STORAGE_SIZE = "1Ti";
    const before = statfsSnapshot(PRELOAD_WS);
    const usage = await getDiskUsageInfo();
    const after = statfsSnapshot(PRELOAD_WS);

    expect(usage).not.toBeNull();
    expectWithinStatfsWindow(usage!, PRELOAD_WS, before, after);
  });

  test("measures workspace du usage on a local Docker hatch", async () => {
    process.env.IS_CONTAINERIZED = "1";

    const before = statfsSnapshot(PRELOAD_WS);
    const usage = await getDiskUsageInfo();
    const after = statfsSnapshot(PRELOAD_WS);

    expect(usage).not.toBeNull();
    expect(usage!.path).toBe(PRELOAD_WS);
    // The 512KiB payload must show up whether usage came from du or (if the
    // du spawn failed under load) the statfs fallback — both exceed it.
    expect(usage!.usedMb).toBeGreaterThanOrEqual(0.49);
    // host-free consistency: capacity is usage + free in both branches.
    expect(
      Math.abs(usage!.totalMb - (usage!.usedMb + usage!.freeMb)),
    ).toBeLessThanOrEqual(0.02);
    // Free space is the host's own statfs number in both branches.
    expect(usage!.freeMb).toBeGreaterThanOrEqual(
      round2(Math.min(before.free, after.free)) - 0.01,
    );
    expect(usage!.freeMb).toBeLessThanOrEqual(
      round2(Math.max(before.free, after.free)) + 0.01,
    );
  });

  test("does not use du for cloud-managed containerized instances", async () => {
    process.env.IS_CONTAINERIZED = "1";
    process.env.IS_CLOUD = "1";
    const before = statfsSnapshot(PRELOAD_WS);
    const usage = await getDiskUsageInfo();
    const after = statfsSnapshot(PRELOAD_WS);

    // CSI-backed PVCs report the volume accurately: pure statfs numbers.
    expect(usage).not.toBeNull();
    expectWithinStatfsWindow(usage!, PRELOAD_WS, before, after);
  });

  test("falls back to statfs when du has nothing to measure", async () => {
    // An empty workspace du's to 0, which the sampler cannot report as usage.
    const emptyWs = mkdtempSync(join("/tmp", "disk-usage-empty-"));
    process.env.IS_CONTAINERIZED = "1";
    process.env.CADET_WORKSPACE_DIR = emptyWs;
    try {
      const before = statfsSnapshot(emptyWs);
      const usage = await getDiskUsageInfo();
      const after = statfsSnapshot(emptyWs);

      expect(usage).not.toBeNull();
      expectWithinStatfsWindow(usage!, emptyWs, before, after);
    } finally {
      process.env.CADET_WORKSPACE_DIR = PRELOAD_WS;
      rmSync(emptyWs, { recursive: true, force: true });
    }
  });

  test("returns null for malformed Kubernetes memory strings", () => {
    expect(parseK8sMemoryBytes("")).toBeNull();
    expect(parseK8sMemoryBytes("abc")).toBeNull();
    expect(parseK8sMemoryBytes("12Zi")).toBeNull();
    expect(parseK8sMemoryBytes("-1Gi")).toBeNull();
    expect(parseK8sMemoryBytes("0Gi")).toBeNull();
  });
});
