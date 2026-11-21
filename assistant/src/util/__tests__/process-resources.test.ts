import { describe, expect, test } from "bun:test";

import { parseCpuTime, sampleProcessResources } from "../process-resources.js";

describe("process resources", () => {
  test("parses macOS cumulative CPU times including fractions and days", () => {
    expect(parseCpuTime("02:41.52")).toBeCloseTo(161.52);
    expect(parseCpuTime("06:09:53")).toBe(22193);
    expect(parseCpuTime("2-06:09:53")).toBe(194993);
  });
  test("samples live resident memory and CPU without reporting nonexistent PIDs as zero", async () => {
    const usage = await sampleProcessResources([process.pid, 2147483647]);
    if (process.platform === "linux") {
      expect(usage.get(process.pid)?.rssBytes).toBeGreaterThan(0);
      expect(usage.get(process.pid)?.cpuPct).toBeGreaterThanOrEqual(0);
    }
    expect(usage.has(2147483647)).toBe(false);
    expect(await sampleProcessResources([])).toEqual(new Map());
  });
});
