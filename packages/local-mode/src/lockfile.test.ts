import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getLockfileData, saveLockfileAssistant } from "./lockfile";
import { GATEWAY_PORT } from "./lockfile-contract";

let dir: string;
let lockfilePath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lockfile-test-"));
  // The save resolves its paths from the environment: XDG config home plus
  // the production environment dir.
  lockfilePath = path.join(dir, "cadet", "lockfile.json");
  process.env.XDG_CONFIG_HOME = dir;
  fs.mkdirSync(path.dirname(lockfilePath), { recursive: true });
});

afterEach(() => {
  delete process.env.XDG_CONFIG_HOME;
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeOnDisk(value: unknown): void {
  fs.mkdirSync(path.dirname(lockfilePath), { recursive: true });
  fs.writeFileSync(lockfilePath, JSON.stringify(value, null, 2));
}

function readOnDisk(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(lockfilePath, "utf-8")) as Record<
    string,
    unknown
  >;
}

describe("getLockfileData", () => {
  test("returns the empty lockfile when no file exists", () => {
    const result = getLockfileData();
    expect(result).toEqual({
      ok: true,
      data: { assistants: [], activeAssistant: null },
      raw: { assistants: [], activeAssistant: null },
    });
  });

  test("validates and salvages a partially-malformed file", () => {
    writeOnDisk({
      activeAssistant: "asst_ok",
      assistants: [
        { assistantId: "asst_ok", cloud: "local" },
        { cloud: "local", runtimeUrl: "http://b" }, // missing assistantId
      ],
    });

    const result = getLockfileData();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.assistants).toEqual([
        { assistantId: "asst_ok", cloud: "local", port: GATEWAY_PORT },
      ]);
    }
  });

  test("salvages a legacy entry that predates cloud", () => {
    // An entry written by an older CLI: no `cloud`, and the runtime URL stored
    // under the legacy `localUrl` key rather than `runtimeUrl`. Only the
    // identity is guaranteed, so the entry must still be returned (the modeled
    // fields it lacks are simply absent on the wire value).
    writeOnDisk({
      activeAssistant: "asst_legacy",
      assistants: [
        { assistantId: "asst_legacy", localUrl: "http://127.0.0.1:7777" },
      ],
    });

    const result = getLockfileData();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.assistants).toEqual([
        {
          assistantId: "asst_legacy",
          cloud: "local",
          port: GATEWAY_PORT,
        },
      ]);
      expect(result.data.activeAssistant).toBe("asst_legacy");
    }
  });

  test("fails with status 500 on malformed JSON", () => {
    fs.writeFileSync(lockfilePath, "{ not json");
    const result = getLockfileData();
    expect(result).toEqual({ ok: false, status: 500 });
  });
});

describe("saveLockfileAssistant", () => {
  test("rejects an assistant with no id", () => {
    expect(() => saveLockfileAssistant({ cloud: "local" }, undefined)).toThrow(
      "Missing assistant.assistantId",
    );
  });

  test("a newer client's unknown root fields survive; its unknown entry fields do not", () => {
    // The root is a loose object, so a root key this build does not model
    // round-trips a read-modify-write. The entry shape is the contract
    // itself: the parsed write-back drops entry fields outside the schema,
    // so a newer writer's entry extensions ride the schema or nothing.
    writeOnDisk({
      schemaVersion: 99,
      activeAssistant: "asst_old",
      assistants: [
        {
          assistantId: "asst_old",
          cloud: "cloud",
          futureField: "keep-me",
        },
      ],
    });

    saveLockfileAssistant(
      { assistantId: "asst_new", cloud: "local" },
      "asst_new",
    );

    const onDisk = readOnDisk();
    expect(onDisk.schemaVersion).toBe(99);
    expect(onDisk.activeAssistant).toBe("asst_new");
    const assistants = onDisk.assistants as Array<Record<string, unknown>>;
    const old = assistants.find((a) => a.assistantId === "asst_old");
    expect(old?.futureField).toBeUndefined();
  });

  test("merges fields into an existing entry", () => {
    writeOnDisk({
      activeAssistant: null,
      assistants: [{ assistantId: "asst_1", cloud: "local" }],
    });

    saveLockfileAssistant(
      { assistantId: "asst_1", name: "Renamed" },
      undefined,
    );

    const assistants = readOnDisk().assistants as Array<
      Record<string, unknown>
    >;
    expect(assistants).toHaveLength(1);
    expect(assistants[0]).toMatchObject({
      assistantId: "asst_1",
      cloud: "local",
      name: "Renamed",
    });
  });

  test("a name-only payload preserves the placement and drops the legacy secret fields", () => {
    const entry = {
      assistantId: "asst_1",
      cloud: "local",
      name: "Old Name",
      instanceDir: "/tmp/x",
      port: 7830,
      daemonPort: 7831,
      bearerToken: "bt-on-disk-secret",
      guardianBootstrapSecret: "gb-on-disk-secret",
    };
    writeOnDisk({ activeAssistant: "asst_1", assistants: [entry] });

    saveLockfileAssistant({ assistantId: "asst_1", name: "Renamed" });

    const assistants = readOnDisk().assistants as Array<
      Record<string, unknown>
    >;
    expect(assistants).toHaveLength(1);
    // The secrets moved to the xdg token files: the first write through the
    // contract scrubs the legacy on-disk copies.
    expect(assistants[0]).toEqual({
      assistantId: "asst_1",
      cloud: "local",
      name: "Renamed",
      instanceDir: "/tmp/x",
      port: 7830,
      daemonPort: 7831,
    });
  });

  test("preserves activeAssistant when no active id is provided", () => {
    writeOnDisk({
      activeAssistant: "asst_active",
      assistants: [
        {
          assistantId: "asst_active",
          cloud: "local",
        },
        { assistantId: "asst_1", cloud: "local" },
      ],
    });

    saveLockfileAssistant({ assistantId: "asst_1", name: "Renamed" });

    expect(readOnDisk().activeAssistant).toBe("asst_active");
  });
});

describe("lockfile writers under lock contention", () => {
  const entry = {
    assistantId: "asst_1",
    cloud: "local",
    name: "Old Name",
  };

  function holdLock(): string {
    const lockDir = `${lockfilePath}.lock`;
    fs.mkdirSync(lockDir);
    return lockDir;
  }

  test("upsert refuses with 423 and leaves the file untouched", () => {
    writeOnDisk({ activeAssistant: null, assistants: [entry] });
    const before = fs.readFileSync(lockfilePath, "utf-8");
    holdLock();

    expect(() =>
      saveLockfileAssistant({ assistantId: "asst_2", cloud: "local" }),
    ).toThrow();
    expect(fs.readFileSync(lockfilePath, "utf-8")).toBe(before);
  });
});
