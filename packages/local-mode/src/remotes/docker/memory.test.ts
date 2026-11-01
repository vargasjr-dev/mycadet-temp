import { describe, expect, test } from "bun:test";

import { machineMemoryRunArgs } from "./memory";

describe("machineMemoryRunArgs", () => {
  test("an unset policy emits nothing — today's unlimited launch", () => {
    expect(machineMemoryRunArgs(undefined)).toEqual([]);
    expect(machineMemoryRunArgs(null)).toEqual([]);
    expect(machineMemoryRunArgs({})).toEqual([]);
  });

  test("a pinned max carries the swap pin", () => {
    expect(machineMemoryRunArgs({ max: 8 * 1024 ** 3 })).toEqual([
      "--memory",
      String(8 * 1024 ** 3),
      "--memory-swap",
      String(8 * 1024 ** 3),
    ]);
  });

  test("a pinned high emits only the reservation — no hard cap", () => {
    expect(machineMemoryRunArgs({ high: 6 * 1024 ** 3 })).toEqual([
      "--memory-reservation",
      String(6 * 1024 ** 3),
    ]);
  });

  test("both pinned: swap rides max, never alone", () => {
    const max = 8 * 1024 ** 3;
    const high = 6 * 1024 ** 3;
    expect(machineMemoryRunArgs({ max, high })).toEqual([
      "--memory",
      String(max),
      "--memory-swap",
      String(max),
      "--memory-reservation",
      String(high),
    ]);
  });
});
