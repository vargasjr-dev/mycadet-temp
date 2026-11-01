import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The plan operation's only host seam is the docker inspect — mocked at the
// package-internal exec module; everything else is a pure function of the
// entry + the inspect answer.
const execOutputMock = mock(async () => "");

mock.module("../exec", () => {
  const real = require("../exec");
  return { ...real, execOutput: execOutputMock };
});

import { planMachine } from "./machine-plan";
import type { LockfileAssistant } from "../lockfile-contract";

let dir = "";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "machine-plan-test-"));
  process.env.XDG_CONFIG_HOME = dir;
  execOutputMock.mockImplementation(async () => "");
});

afterEach(() => {
  delete process.env.XDG_CONFIG_HOME;
  fs.rmSync(dir, { recursive: true, force: true });
});

function dockerEntry(machine?: {
  memory: { max?: number; high?: number };
}): LockfileAssistant {
  return {
    assistantId: "asst_plan_docker",
    cloud: "docker",
    port: 7830,
    machine,
  } as unknown as LockfileAssistant;
}

function inspectAnswer(limits: {
  memory?: number;
  reservation?: number;
  swap?: number;
}): string {
  return `Memory=${limits.memory ?? 0} Reservation=${limits.reservation ?? 0} Swap=${limits.swap ?? 0}`;
}

describe("planMachine — docker", () => {
  test("no policy and an unlimited container = no diff", async () => {
    execOutputMock.mockImplementation(
      async () => inspectAnswer({}),
    );
    const result = await planMachine(dockerEntry());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.stored).toBeUndefined();
      expect(result.applied).toEqual({
        maxBytes: undefined,
        highBytes: undefined,
        swapBytes: undefined,
      });
      expect(result.changes).toEqual([]);
      expect(result.requiresRecreate).toBe(false);
      expect(result.note).toBeUndefined();
    }
  });

  test("a stored policy that matches the live flags = no diff", async () => {
    const max = 8 * 1024 ** 3;
    const high = 6 * 1024 ** 3;
    execOutputMock.mockImplementation(
      async () => inspectAnswer({ memory: max, reservation: high, swap: max }),
    );
    const result = await planMachine(
      dockerEntry({ memory: { max, high } }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.changes).toEqual([]);
      expect(result.requiresRecreate).toBe(false);
      expect(result.note).toBeUndefined();
    }
  });

  test("a stored policy on an unlimited container wants a recreate", async () => {
    const max = 8 * 1024 ** 3;
    execOutputMock.mockImplementation(async () => inspectAnswer({}));
    const result = await planMachine(dockerEntry({ memory: { max } }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.changes).toEqual([
        { field: "memory.max", from: undefined, to: max },
      ]);
      expect(result.requiresRecreate).toBe(true);
      expect(result.note).toContain("machine apply");
      expect(result.note).toContain("sleep, then wake");
    }
  });

  test("an unpinned swap on a matching max is its own change", async () => {
    const max = 8 * 1024 ** 3;
    execOutputMock.mockImplementation(
      async () => inspectAnswer({ memory: max, swap: 0 }),
    );
    const result = await planMachine(dockerEntry({ memory: { max } }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.changes).toEqual([
        { field: "memory-swap", from: undefined, to: max },
      ]);
      expect(result.requiresRecreate).toBe(true);
    }
  });

  test("a stored soft limit alone diffs against the live reservation", async () => {
    const high = 4 * 1024 ** 3;
    execOutputMock.mockImplementation(async () => inspectAnswer({}));
    const result = await planMachine(dockerEntry({ memory: { high } }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.changes).toEqual([
        { field: "memory.high", from: undefined, to: high },
      ]);
      expect(result.requiresRecreate).toBe(true);
    }
  });

  test("no stored policy on a hand-limited container wants the flags gone", async () => {
    const applied = 4 * 1024 ** 3;
    execOutputMock.mockImplementation(
      async () => inspectAnswer({ memory: applied, reservation: applied, swap: applied }),
    );
    const result = await planMachine(dockerEntry());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.changes).toEqual([
        { field: "memory.max", from: applied, to: undefined },
        { field: "memory.high", from: applied, to: undefined },
      ]);
      expect(result.requiresRecreate).toBe(true);
    }
  });

  test("a missing container answers honestly — the policy applies on recreate", async () => {
    execOutputMock.mockImplementation(async () => {
      throw new Error("No such object: asst_plan_docker-assistant");
    });
    const max = 8 * 1024 ** 3;
    const result = await planMachine(
      dockerEntry({ memory: { max } }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.applied).toBeUndefined();
      expect(result.changes).toEqual([]);
      expect(result.requiresRecreate).toBe(false);
      expect(result.note).toContain("isn't running");
      expect(result.note).toContain("machine apply");
    }
  });
});

describe("planMachine — remotes without a docker diff", () => {
  test("local: the policy is a hint — never a recreate", async () => {
    const result = await planMachine({
      assistantId: "asst_plan_local",
      cloud: "local",
      port: 7830,
      machine: { memory: { high: 4 * 1024 ** 3 } },
    } as unknown as LockfileAssistant);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.applied).toBeUndefined();
      expect(result.changes).toEqual([]);
      expect(result.requiresRecreate).toBe(false);
      expect(result.note).toContain("worker spawn");
    }
  });

  test("local with no policy says what unset means", async () => {
    const result = await planMachine({
      assistantId: "asst_plan_local",
      cloud: "local",
      port: 7830,
    } as unknown as LockfileAssistant);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.note).toContain("derived from the machine's total");
    }
  });

  test("unsupported remotes say so instead of pretending to diff", async () => {
    const result = await planMachine({
      assistantId: "asst_plan_cloud",
      cloud: "cloud",
    } as unknown as LockfileAssistant);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.note).toBe("no apply path for this remote yet");
      expect(result.requiresRecreate).toBe(false);
    }
  });
});
