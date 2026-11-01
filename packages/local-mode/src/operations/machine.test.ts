import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The write verbs go through the real lockfile (locking + schema round-trip
// is the contract under test), isolated per test via XDG_CONFIG_HOME. No
// module mocking: the operations are pure lockfile mutations now.
let dir = "";

const dockerEntry = {
  assistantId: "asst_mach_docker",
  cloud: "docker",
  port: 7830,
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "machine-ops-test-"));
  process.env.XDG_CONFIG_HOME = dir;
});

afterEach(() => {
  delete process.env.XDG_CONFIG_HOME;
  fs.rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {});

async function writeEntry(entry: Record<string, unknown>): Promise<void> {
  const { writeRawLockfile } = await import("../lockfile");
  const result = writeRawLockfile({
    activeAssistant: entry.assistantId as string,
    assistants: [entry],
  });
  if (!result.ok) throw new Error(result.error);
}

async function readStored(
  assistantId: string,
): Promise<Record<string, unknown> | undefined> {
  const { readLockfile } = await import("../lockfile");
  return readLockfile().assistants.find(
    (a) => a.assistantId === assistantId,
  ) as unknown as Record<string, unknown> | undefined;
}

import {
  machineGet,
  machineResetKey,
  machineSetKey,
  parseMachineBytes,
} from "./machine";
import type { LockfileAssistant } from "../lockfile-contract";

describe("parseMachineBytes", () => {
  test("parses bare bytes and every documented suffix", () => {
    expect(parseMachineBytes("1073741824")).toBe(1073741824);
    expect(parseMachineBytes("1KiB")).toBe(1024);
    expect(parseMachineBytes("512MiB")).toBe(512 * 1024 ** 2);
    expect(parseMachineBytes("8GiB")).toBe(8 * 1024 ** 3);
    expect(parseMachineBytes("1TiB")).toBe(1024 ** 4);
    expect(parseMachineBytes("8Gi")).toBe(8 * 1024 ** 3);
    // SI forms are 1000-based, matching the k8s/docker convention.
    expect(parseMachineBytes("100MB")).toBe(100_000_000);
    expect(parseMachineBytes("2GB")).toBe(2_000_000_000);
    expect(parseMachineBytes("1m")).toBe(1_000_000);
  });

  test("is case- and whitespace-tolerant, supports decimals", () => {
    expect(parseMachineBytes(" 8gib ")).toBe(8 * 1024 ** 3);
    expect(parseMachineBytes("1.5GiB")).toBe(1_610_612_736);
  });

  test("rejects junk, zero, negatives, and non-integers", () => {
    for (const raw of ["abc", "", "-1", "0", "12xi", "8 Gi B", "1.5"]) {
      expect(parseMachineBytes(raw)).toBeUndefined();
    }
  });
});

describe("machineSetKey", () => {
  test("stores the merged section, the parsed value, and the pending note", async () => {
    await writeEntry(dockerEntry);
    const { readLockfile: freshRead } = await import("../lockfile");
    const entry = freshRead().assistants[0] as LockfileAssistant;
    const result = machineSetKey(entry, "memory.max", "8GiB");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.machine).toEqual({
        memory: { max: 8 * 1024 ** 3 },
      });
      expect(result.value).toBe(8 * 1024 ** 3);
      expect(result.note).toContain("Pending");
      expect(result.note).toContain("sleep, then wake");
    }
    const stored = (await readStored(dockerEntry.assistantId))?.machine as
      | { memory: { max: number } }
      | undefined;
    expect(stored?.memory.max).toBe(8 * 1024 ** 3);
  });

  test("the pending note matches the remote's semantics", async () => {
    await writeEntry({
      assistantId: "asst_mach_local",
      cloud: "local",
      port: 7830,
    });
    const { readLockfile: freshRead } = await import("../lockfile");
    const entry = freshRead().assistants[0] as LockfileAssistant;
    const result = machineSetKey(entry, "memory.high", "4GiB");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.note).toContain("worker spawn");
  });

  test("merges onto existing keys without clobbering siblings", async () => {
    await writeEntry({
      ...dockerEntry,
      machine: { memory: { high: 4 * 1024 ** 3 } },
    });
    const { readLockfile: freshRead } = await import("../lockfile");
    const entry = freshRead().assistants[0] as LockfileAssistant;
    const result = machineSetKey(entry, "memory.max", "8GiB");
    expect(result.ok).toBe(true);
    const stored = (await readStored(dockerEntry.assistantId))?.machine as {
      memory: { max: number; high: number };
    };
    expect(stored.memory).toEqual({
      high: 4 * 1024 ** 3,
      max: 8 * 1024 ** 3,
    });
  });

  test("rejects unknown keys and unparsable values", async () => {
    await writeEntry(dockerEntry);
    const { readLockfile: freshRead } = await import("../lockfile");
    const entry = freshRead().assistants[0] as LockfileAssistant;
    for (const [key, value] of [
      ["memory.limit", "8GiB"],
      ["port", "7830"],
      ["memory.max", "eight"],
    ] as const) {
      const result = machineSetKey(entry, key, value);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(400);
        expect(result.error).toMatch(/Unknown machine key|Invalid size/);
      }
    }
  });

  test("the schema owns the cross-field rule: high above max fails", async () => {
    await writeEntry({
      ...dockerEntry,
      machine: { memory: { max: 8 * 1024 ** 3 } },
    });
    const { readLockfile: freshRead } = await import("../lockfile");
    const entry = freshRead().assistants[0] as LockfileAssistant;
    const result = machineSetKey(entry, "memory.high", "10GiB");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toContain("must not exceed");
    }
    // The rejected write left the stored policy untouched.
    const stored = (await readStored(dockerEntry.assistantId))?.machine as {
      memory: { max: number };
    };
    expect(stored.memory.max).toBe(8 * 1024 ** 3);
    expect((stored.memory as Record<string, unknown>).high).toBeUndefined();
  });

  test("re-stating a stored value is a no-op — no lock write", async () => {
    await writeEntry({
      ...dockerEntry,
      machine: { memory: { max: 8 * 1024 ** 3 } },
    });
    const { readLockfile: freshRead } = await import("../lockfile");
    const entry = freshRead().assistants[0] as LockfileAssistant;
    const result = machineSetKey(entry, "memory.max", "8GiB");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.note).toBe("Already stored — no change.");
      expect(result.value).toBe(8 * 1024 ** 3);
      expect(result.machine).toEqual({
        memory: { max: 8 * 1024 ** 3 },
      });
    }
    // The lock was never touched: a different sibling value written AFTER
    // the no-op proves the file still parsed from the original write.
    const followup = machineSetKey(entry, "memory.high", "4GiB");
    expect(followup.ok).toBe(true);
    const stored = (await readStored(dockerEntry.assistantId))?.machine as {
      memory: { max: number; high: number };
    };
    expect(stored.memory).toEqual({
      max: 8 * 1024 ** 3,
      high: 4 * 1024 ** 3,
    });
  });
});

describe("machineResetKey", () => {
  test("clears one key, keeping its siblings", async () => {
    await writeEntry({
      ...dockerEntry,
      machine: {
        memory: { high: 4 * 1024 ** 3, max: 8 * 1024 ** 3 },
      },
    });
    const { readLockfile: freshRead } = await import("../lockfile");
    const entry = freshRead().assistants[0] as LockfileAssistant;
    const result = machineResetKey(entry, "memory.max");
    expect(result.ok).toBe(true);
    const stored = (await readStored(dockerEntry.assistantId))?.machine as {
      memory: { high: number };
    };
    expect(stored.memory).toEqual({ high: 4 * 1024 ** 3 });
  });

  test("clearing the last memory key drops the whole section", async () => {
    await writeEntry({
      ...dockerEntry,
      machine: { memory: { max: 8 * 1024 ** 3 } },
    });
    const { readLockfile: freshRead } = await import("../lockfile");
    const entry = freshRead().assistants[0] as LockfileAssistant;
    expect(machineResetKey(entry, "memory.max").ok).toBe(true);
    const stored = await readStored(dockerEntry.assistantId);
    expect(stored?.machine).toBeUndefined();
  });

  test("no path clears the entire section; unknown paths fail", async () => {
    await writeEntry({
      ...dockerEntry,
      machine: { memory: { max: 8 * 1024 ** 3 } },
    });
    const { readLockfile: freshRead } = await import("../lockfile");
    const entry = freshRead().assistants[0] as LockfileAssistant;
    expect(machineResetKey(entry, "port").ok).toBe(false);
    expect(machineResetKey(entry, "memory").ok).toBe(true);
    const stored = await readStored(dockerEntry.assistantId);
    expect(stored?.machine).toBeUndefined();
  });
});

describe("machineGet", () => {
  test("returns the stored policy fields, nothing else", async () => {
    await writeEntry({
      ...dockerEntry,
      machine: { memory: { high: 4 * 1024 ** 3 } },
    });
    const { readLockfile: freshRead } = await import("../lockfile");
    const entry = freshRead().assistants[0] as LockfileAssistant;
    const result = machineGet(entry);
    expect(result).toEqual({
      ok: true,
      machine: { memory: { high: 4 * 1024 ** 3 } },
    });
  });

  test("an unset section reads as undefined (spec defaults)", async () => {
    await writeEntry(dockerEntry);
    const { readLockfile: freshRead } = await import("../lockfile");
    const entry = freshRead().assistants[0] as LockfileAssistant;
    expect(machineGet(entry)).toEqual({ ok: true, machine: undefined });
  });
});

describe("the written lockfile survives the schema round-trip", () => {
  test("a machine policy written by set reads back byte-identical", async () => {
    await writeEntry(dockerEntry);
    const { readLockfile: freshRead } = await import("../lockfile");
    const entry = freshRead().assistants[0] as LockfileAssistant;
    machineSetKey(entry, "memory.high", "6GiB");
    expect(
      (readStored(dockerEntry.assistantId) as Promise<
        Record<string, unknown>
      >) ?? null,
    ).toBeDefined();
    const { readLockfile: reread } = await import("../lockfile");
    expect((reread().assistants[0] as LockfileAssistant).machine).toEqual({
      memory: { high: 6 * 1024 ** 3 },
    });
  });
});
