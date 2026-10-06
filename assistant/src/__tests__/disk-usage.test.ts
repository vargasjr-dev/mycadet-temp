import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, statfsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";

// Captured at module scope: the preload cleans up its env var between suites.
const PRELOAD_WS = process.env.VELLUM_WORKSPACE_DIR!;

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

const { __resetDiskUsageCacheForTests, getDiskUsageInfo, parseK8sMemoryBytes } =
  await import("../util/disk-usage.js");

// Env knobs the sampler reads at call time; no module mocking needed.
const ENV_VARS = [
  "VELLUM_MINIKUBE_STORAGE_SIZE",
  "IS_CONTAINERIZED",
  "IS_PLATFORM",
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
    process.env.VELLUM_WORKSPACE_DIR = PRELOAD_WS;
    writeFileSync(PAYLOAD, Buffer.alloc(512 * 1024));
    __resetDiskUsageCacheForTests();
  });

  test("reports real statfs usage", async () => {
    const stats = statfsSync(PRELOAD_WS);
    const total = Number(stats.bsize) * Number(stats.blocks);
    const free = Number(stats.bsize) * Number(stats.bavail);

    const usage = await getDiskUsageInfo();

    expect(usage).toEqual({
      path: PRELOAD_WS,
      totalMb: round2(total),
      usedMb: round2(total - free),
      freeMb: round2(free),
    });
  });

  test("falls back to root when the workspace path does not exist", async () => {
    process.env.VELLUM_WORKSPACE_DIR = "/tmp/does-not-exist-disk-usage-test";
    try {
      const usage = await getDiskUsageInfo();
      expect(usage?.path).toBe("/");
    } finally {
      // Restore rather than delete: the sampler reads the workspace at call
      // time and later tests still need the preload's workspace.
      process.env.VELLUM_WORKSPACE_DIR = PRELOAD_WS;
    }
  });

  test("uses PVC capacity and du usage when the host filesystem is larger", async () => {
    // A 1MiB PVC is always smaller than the real host filesystem, so the
    // hostPath detection fires and capacity is the quota, usage is `du`.
    process.env.VELLUM_MINIKUBE_STORAGE_SIZE = "1Mi";
    const du = await duBytes([PRELOAD_WS]);

    const usage = await getDiskUsageInfo();

    expect(usage).toEqual({
      path: PRELOAD_WS,
      totalMb: 1,
      usedMb: round2(du),
      freeMb: round2(Math.max(0, MIB - du)),
    });
  });

  test("adds /data to du usage when it exists separately", async () => {
    process.env.VELLUM_MINIKUBE_STORAGE_SIZE = "1Mi";
    const paths = [PRELOAD_WS, ...(existsSync("/data") ? ["/data"] : [])];
    const du = await duBytes(paths);

    const usage = await getDiskUsageInfo();

    expect(usage?.usedMb).toBe(round2(du));
    expect(usage?.totalMb).toBe(1);
  });

  test("a PVC at least as large as the filesystem reports statfs directly", async () => {
    // 1TiB is larger than any test filesystem: the hostPath detection must
    // NOT fire, so the sampler trusts statfs instead of `du`.
    process.env.VELLUM_MINIKUBE_STORAGE_SIZE = "1Ti";
    const stats = statfsSync(PRELOAD_WS);
    const total = Number(stats.bsize) * Number(stats.blocks);
    const free = Number(stats.bsize) * Number(stats.bavail);

    const usage = await getDiskUsageInfo();

    expect(usage).toEqual({
      path: PRELOAD_WS,
      totalMb: round2(total),
      usedMb: round2(total - free),
      freeMb: round2(free),
    });
  });

  test("measures workspace du usage on a local Docker hatch", async () => {
    process.env.IS_CONTAINERIZED = "1";
    const stats = statfsSync(PRELOAD_WS);
    const free = Number(stats.bsize) * Number(stats.bavail);
    const du = await duBytes([PRELOAD_WS]);

    const usage = await getDiskUsageInfo();

    // The volume can grow into host headroom, so capacity is usage + free.
    expect(usage).toEqual({
      path: PRELOAD_WS,
      totalMb: round2(du + free),
      usedMb: round2(du),
      freeMb: round2(free),
    });
  });

  test("does not use du for platform-managed containerized instances", async () => {
    process.env.IS_CONTAINERIZED = "1";
    process.env.IS_PLATFORM = "1";
    const stats = statfsSync(PRELOAD_WS);
    const total = Number(stats.bsize) * Number(stats.blocks);
    const free = Number(stats.bsize) * Number(stats.bavail);

    const usage = await getDiskUsageInfo();

    // CSI-backed PVCs report the volume accurately: pure statfs numbers, and
    // usedMb stays consistent with the filesystem rather than a du run.
    expect(usage).toEqual({
      path: PRELOAD_WS,
      totalMb: round2(total),
      usedMb: round2(total - free),
      freeMb: round2(free),
    });
  });

  test("falls back to statfs when du has nothing to measure", async () => {
    // An empty workspace du's to 0, which the sampler cannot report as usage.
    const emptyWs = mkdtempSync(join("/tmp", "disk-usage-empty-"));
    process.env.IS_CONTAINERIZED = "1";
    process.env.VELLUM_WORKSPACE_DIR = emptyWs;
    try {
      const stats = statfsSync(emptyWs);
      const total = Number(stats.bsize) * Number(stats.blocks);
      const free = Number(stats.bsize) * Number(stats.bavail);

      const usage = await getDiskUsageInfo();

      expect(usage).toEqual({
        path: emptyWs,
        totalMb: round2(total),
        usedMb: round2(total - free),
        freeMb: round2(free),
      });
    } finally {
      process.env.VELLUM_WORKSPACE_DIR = PRELOAD_WS;
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
