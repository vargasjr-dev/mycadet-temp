import { GATEWAY_PORT } from "../lockfile-contract";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { guardianTokenPath } from "../config";
import { unpairAssistant } from "../unpair";

let tmpDir: string;
let lockfilePath: string;
let configDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cadet-unpair-"));
  // The shared read resolves its path from the environment (XDG config home
  // plus the production env dir), so the fixture writes there.
  lockfilePath = path.join(tmpDir, "cadet", "lockfile.json");
  configDir = path.join(tmpDir, "config");
  // The save resolves its paths from the environment; tests point it at the
  // per-test tmp dir.
  process.env.XDG_CONFIG_HOME = tmpDir;
});

afterEach(() => {
  delete process.env.XDG_CONFIG_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const writeLockfile = (data: Record<string, unknown>): void => {
  fs.mkdirSync(path.dirname(lockfilePath), { recursive: true });
  fs.writeFileSync(lockfilePath, JSON.stringify(data));
};

const readLockfileFromDisk = (): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(lockfilePath, "utf-8")) as Record<string, unknown>;

const seedGuardianToken = (assistantId: string): string => {
  const tokenPath = guardianTokenPath(assistantId);
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  fs.writeFileSync(tokenPath, JSON.stringify({ accessToken: "tok" }));
  return tokenPath;
};

describe("unpairAssistant", () => {
  test("removes the paired entry, deletes its guardian token, and reassigns the active pointer", () => {
    writeLockfile({
      assistants: [
        { assistantId: "paired-1", runtimeUrl: "https://h" },
        { assistantId: "local-1", cloud: "local", futureField: "keep-me" },
      ],
      activeAssistant: "paired-1",
    });
    const tokenPath = seedGuardianToken("paired-1");

    const result = unpairAssistant("paired-1");

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // Active falls back to the first remaining entry, matching the CLI's
    // removeAssistantEntry semantics.
    expect(result.lockfile.activeAssistant).toBe("local-1");
    expect(result.lockfile.assistants.map((a) => a.assistantId)).toEqual([
      "local-1",
    ]);
    expect(fs.existsSync(tokenPath)).toBe(false);

    // The entry shape is the contract: the parsed write-back keeps the
    // modeled fields and drops anything a newer writer added to an entry.
    const onDisk = readLockfileFromDisk();
    expect(onDisk.assistants).toEqual([
      { assistantId: "local-1", cloud: "local", port: GATEWAY_PORT },
    ]);
    expect(onDisk.activeAssistant).toBe("local-1");
  });

  test("removing the sole (active) entry leaves no active pointer", () => {
    writeLockfile({
      assistants: [{ assistantId: "paired-1", runtimeUrl: "https://h" }],
      activeAssistant: "paired-1",
    });

    const result = unpairAssistant("paired-1");

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.lockfile.activeAssistant).toBeNull();
    expect(result.lockfile.assistants).toEqual([]);
  });

  test("reassigns the active pointer past tolerated malformed entries", () => {
    writeLockfile({
      assistants: [
        { assistantId: "paired-1", runtimeUrl: "https://h" },
        { notAnAssistant: true },
        { assistantId: "local-1", cloud: "local" },
      ],
      activeAssistant: "paired-1",
    });

    const result = unpairAssistant("paired-1");

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.lockfile.activeAssistant).toBe("local-1");
  });

  test("a failed token delete aborts before touching the lockfile", () => {
    writeLockfile({
      assistants: [{ assistantId: "paired-1", runtimeUrl: "https://h" }],
      activeAssistant: "paired-1",
    });
    // A non-empty directory at the token path makes rmSync (non-recursive)
    // throw, standing in for EPERM-style failures.
    const tokenPath = guardianTokenPath("paired-1");
    fs.mkdirSync(path.join(tokenPath, "oops"), { recursive: true });

    const result = unpairAssistant("paired-1");

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.status).toBe(500);
    expect(result.error).toContain("guardian token");
    // The entry is untouched, so the unpair can be retried.
    expect(readLockfileFromDisk().assistants).toEqual([
      { assistantId: "paired-1", runtimeUrl: "https://h" },
    ]);
    expect(readLockfileFromDisk().activeAssistant).toBe("paired-1");
  });

  test("restores the guardian token when the lockfile write fails", () => {
    writeLockfile({
      assistants: [{ assistantId: "paired-1", runtimeUrl: "https://h" }],
      activeAssistant: null,
    });
    const tokenPath = seedGuardianToken("paired-1");
    // A directory parked at the write's temp path makes the atomic rename
    // fail deterministically after the token has been deleted (root ignores
    // directory permissions, so this beats chmod).
    fs.mkdirSync(`${lockfilePath}.tmp.${process.pid}`);
    try {
      const result = unpairAssistant("paired-1");

      expect(result.ok).toBe(false);
      expect(fs.existsSync(tokenPath)).toBe(true);
      expect(fs.readFileSync(tokenPath, "utf-8")).toBe(
        JSON.stringify({ accessToken: "tok" }),
      );
    } finally {
      process.env.XDG_CONFIG_HOME = tmpDir;
    }
  });

  test("unpairs a local entry too — the gateway refuses what it must", () => {
    writeLockfile({
      assistants: [{ assistantId: "local-1", cloud: "local" }],
      activeAssistant: null,
    });
    const tokenPath = seedGuardianToken("local-1");

    const result = unpairAssistant("local-1");

    expect(result.ok).toBe(true);
    expect(fs.existsSync(tokenPath)).toBe(false);
    expect(readLockfileFromDisk().assistants).toEqual([]);
  });

  test("leaves the active pointer alone when it names another assistant", () => {
    writeLockfile({
      assistants: [
        { assistantId: "paired-1", runtimeUrl: "https://h" },
        { assistantId: "local-1", cloud: "local" },
      ],
      activeAssistant: "local-1",
    });

    const result = unpairAssistant("paired-1");

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.lockfile.activeAssistant).toBe("local-1");
  });

  test("succeeds when the guardian token file is already gone", () => {
    writeLockfile({
      assistants: [{ assistantId: "paired-1", runtimeUrl: "https://h" }],
      activeAssistant: null,
    });

    const result = unpairAssistant("paired-1");

    expect(result.ok).toBe(true);
  });

  test("refuses an unknown assistant without touching disk", () => {
    writeLockfile({
      assistants: [{ assistantId: "paired-1", runtimeUrl: "https://h" }],
      activeAssistant: "paired-1",
    });

    const result = unpairAssistant("nope");

    expect(result).toEqual({
      ok: false,
      status: 404,
      error: "No such assistant",
    });
    expect(readLockfileFromDisk().activeAssistant).toBe("paired-1");
  });

  test("refuses with 423 under a held write lock, leaving entry and token alone", () => {
    writeLockfile({
      assistants: [{ assistantId: "paired-1", runtimeUrl: "https://h" }],
      activeAssistant: "paired-1",
    });
    const tokenPath = seedGuardianToken("paired-1");
    fs.mkdirSync(`${lockfilePath}.lock`);
    try {
      const result = unpairAssistant("paired-1");

      expect(result).toMatchObject({ ok: false, status: 423 });
      expect(fs.existsSync(tokenPath)).toBe(true);
      expect(readLockfileFromDisk().assistants).toEqual([
        { assistantId: "paired-1", runtimeUrl: "https://h" },
      ]);
    } finally {
      fs.rmdirSync(`${lockfilePath}.lock`);
    }
  });

  test("a successful unpair leaves no lock dir behind", () => {
    writeLockfile({
      assistants: [{ assistantId: "paired-1", runtimeUrl: "https://h" }],
      activeAssistant: "paired-1",
    });
    seedGuardianToken("paired-1");

    const result = unpairAssistant("paired-1");

    expect(result.ok).toBe(true);
    expect(fs.existsSync(`${lockfilePath}.lock`)).toBe(false);
  });
});
