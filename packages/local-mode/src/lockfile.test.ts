import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createLockfileAssistant,
  getLockfileData,
  isPairedLockfileEntry,
  renameLockfileAssistantIfPresent,
  stampLockfileAssistantOnboardedIfPresent,
  replaceCloudAssistants,
  saveLockfileAssistant,
} from "./lockfile";

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
    const result = getLockfileData(lockfilePath);
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

    const result = getLockfileData(lockfilePath);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.assistants).toEqual([
        { assistantId: "asst_ok", cloud: "local" },
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

    const result = getLockfileData(lockfilePath);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.assistants).toEqual([
        {
          assistantId: "asst_legacy",
          cloud: "local",
        },
      ]);
      expect(result.data.activeAssistant).toBe("asst_legacy");
    }
  });

  test("fails with status 500 on malformed JSON", () => {
    fs.writeFileSync(lockfilePath, "{ not json");
    const result = getLockfileData(lockfilePath);
    expect(result).toEqual({ ok: false, status: 500 });
  });
});

// Hosts consult this so an expired pairing gets re-pair guidance instead of
// hatch/wake; this pins the derivation — a custom remote's addressing,
// never a stored flag.
describe("isPairedLockfileEntry", () => {
  test("classifies custom-remote entries as paired", () => {
    writeOnDisk({
      assistants: [
        {
          assistantId: "paired-1",
          cloud: "custom",
          ipAddress: "h.example.com",
          port: 443,
        },
        { assistantId: "local-1", cloud: "local" },
      ],
      activeAssistant: "local-1",
    });

    expect(isPairedLockfileEntry("paired-1")).toBe(true);
    expect(isPairedLockfileEntry("local-1")).toBe(false);
    expect(isPairedLockfileEntry("missing")).toBe(false);
  });

  test("an absent lockfile never classifies as paired", () => {
    expect(isPairedLockfileEntry("paired-1")).toBe(false);
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

  test("a name-only payload preserves resources and on-disk secrets byte-for-byte", () => {
    const entry = {
      assistantId: "asst_1",
      cloud: "local",
      name: "Old Name",
      resources: {
        instanceDir: "/tmp/x",
        gatewayPort: 7830,
        daemonPort: 7831,
      },
      bearerToken: "bt-on-disk-secret",
      guardianBootstrapSecret: "gb-on-disk-secret",
    };
    writeOnDisk({ activeAssistant: "asst_1", assistants: [entry] });

    saveLockfileAssistant({ assistantId: "asst_1", name: "Renamed" });

    const assistants = readOnDisk().assistants as Array<
      Record<string, unknown>
    >;
    expect(assistants).toHaveLength(1);
    expect(assistants[0]).toEqual({ ...entry, name: "Renamed" });
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

describe("stampLockfileAssistantOnboardedIfPresent", () => {
  const entry = {
    assistantId: "asst_1",
    cloud: "local",
    name: "Credence",
    signingKey: "sk-on-disk-secret",
  };
  const AT = "2026-08-31T00:00:00.000Z";

  test("stamps the entry preserving its other fields and activeAssistant", () => {
    writeOnDisk({ activeAssistant: "asst_other", assistants: [entry] });

    const result = stampLockfileAssistantOnboardedIfPresent(
      lockfilePath,
      "asst_1",
      AT,
    );

    expect(result.ok).toBe(true);
    const onDisk = readOnDisk();
    expect(onDisk.activeAssistant).toBe("asst_other");
    expect(onDisk.assistants).toEqual([{ ...entry, onboardedAt: AT }]);
  });

  // Update-only: a completion racing a CLI retire must not resurrect the row.
  test("refuses a missing entry without writing the file", () => {
    const result = stampLockfileAssistantOnboardedIfPresent(
      lockfilePath,
      "asst_gone",
      AT,
    );

    expect(result).toEqual({
      ok: false,
      status: 404,
      error: "No lockfile entry for this assistant",
    });
    expect(fs.existsSync(lockfilePath)).toBe(false);
  });

  test("keeps an existing stamp: the first completion is the real one", () => {
    const stamped = { ...entry, onboardedAt: "2026-08-01T00:00:00.000Z" };
    writeOnDisk({ activeAssistant: null, assistants: [stamped] });

    const result = stampLockfileAssistantOnboardedIfPresent(
      lockfilePath,
      "asst_1",
      AT,
    );

    expect(result.ok).toBe(true);
    expect(readOnDisk().assistants).toEqual([stamped]);
  });

  test("refuses a corrupt on-disk file without clobbering it", () => {
    fs.writeFileSync(lockfilePath, "{ not json");

    const result = stampLockfileAssistantOnboardedIfPresent(
      lockfilePath,
      "asst_1",
      AT,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
    }
    expect(fs.readFileSync(lockfilePath, "utf-8")).toBe("{ not json");
  });

  test("rejects a missing id or timestamp", () => {
    expect(
      stampLockfileAssistantOnboardedIfPresent(lockfilePath, "", AT).ok,
    ).toBe(false);
    expect(
      stampLockfileAssistantOnboardedIfPresent(lockfilePath, "asst_1", "").ok,
    ).toBe(false);
    expect(fs.existsSync(lockfilePath)).toBe(false);
  });
});

describe("renameLockfileAssistantIfPresent", () => {
  const entry = {
    assistantId: "asst_1",
    cloud: "local",
    name: "Old Name",
    resources: { gatewayPort: 7830, daemonPort: 7831, dataDir: "/tmp/x" },
    signingKey: "sk-on-disk-secret",
    bearerToken: "bt-on-disk-secret",
  };

  test("renames the entry preserving resources, secrets, and activeAssistant", () => {
    writeOnDisk({
      activeAssistant: "asst_other",
      assistants: [entry, { assistantId: "asst_other", cloud: "local" }],
    });

    const result = renameLockfileAssistantIfPresent(
      lockfilePath,
      "asst_1",
      "Renamed",
    );

    expect(result.ok).toBe(true);
    const onDisk = readOnDisk();
    expect(onDisk.activeAssistant).toBe("asst_other");
    const assistants = onDisk.assistants as Array<Record<string, unknown>>;
    expect(assistants).toEqual([
      { ...entry, name: "Renamed" },
      { assistantId: "asst_other", cloud: "local" },
    ]);
  });

  test("refuses a missing entry without writing the file", () => {
    const result = renameLockfileAssistantIfPresent(
      lockfilePath,
      "asst_gone",
      "Renamed",
    );

    expect(result).toEqual({
      ok: false,
      status: 404,
      error: "No lockfile entry for this assistant",
    });
    expect(fs.existsSync(lockfilePath)).toBe(false);
  });

  test("refuses when the id names another process's retired entry", () => {
    writeOnDisk({ activeAssistant: null, assistants: [entry] });
    const before = fs.readFileSync(lockfilePath, "utf-8");

    const result = renameLockfileAssistantIfPresent(
      lockfilePath,
      "asst_retired",
      "Renamed",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(404);
    }
    expect(fs.readFileSync(lockfilePath, "utf-8")).toBe(before);
  });

  test("refuses a corrupt on-disk file without clobbering it", () => {
    fs.writeFileSync(lockfilePath, "{ not json");

    const result = renameLockfileAssistantIfPresent(
      lockfilePath,
      "asst_1",
      "Renamed",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
    }
    expect(fs.readFileSync(lockfilePath, "utf-8")).toBe("{ not json");
  });

  test("refuses non-object JSON on disk without clobbering it", () => {
    for (const raw of ["null", "[]", '"text"', "7"]) {
      fs.writeFileSync(lockfilePath, raw);

      const result = renameLockfileAssistantIfPresent(
        lockfilePath,
        "asst_1",
        "Renamed",
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(409);
      }
      expect(fs.readFileSync(lockfilePath, "utf-8")).toBe(raw);
    }
  });

  test("an already-equal name succeeds without rewriting the file", () => {
    // Compact formatting: any rewrite would re-indent and change the bytes.
    fs.writeFileSync(
      lockfilePath,
      JSON.stringify({ activeAssistant: null, assistants: [entry] }),
    );
    const before = fs.readFileSync(lockfilePath, "utf-8");

    const result = renameLockfileAssistantIfPresent(
      lockfilePath,
      "asst_1",
      "Old Name",
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.lockfile.assistants[0]?.name).toBe("Old Name");
      expect(result.lockfile.assistants[0]).not.toHaveProperty("signingKey");
    }
    expect(fs.readFileSync(lockfilePath, "utf-8")).toBe(before);
  });

  test("rejects a missing id or name without touching disk", () => {
    writeOnDisk({ activeAssistant: null, assistants: [entry] });
    const before = fs.readFileSync(lockfilePath, "utf-8");

    expect(renameLockfileAssistantIfPresent(lockfilePath, "", "N").ok).toBe(
      false,
    );
    expect(
      renameLockfileAssistantIfPresent(lockfilePath, "asst_1", "").ok,
    ).toBe(false);
    expect(fs.readFileSync(lockfilePath, "utf-8")).toBe(before);
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

  test("rename refuses with 423 and leaves the file untouched", () => {
    writeOnDisk({ activeAssistant: null, assistants: [entry] });
    const before = fs.readFileSync(lockfilePath, "utf-8");
    holdLock();

    const result = renameLockfileAssistantIfPresent(
      lockfilePath,
      "asst_1",
      "Renamed",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(423);
    }
    expect(fs.readFileSync(lockfilePath, "utf-8")).toBe(before);
  });

  test("upsert refuses with 423 and leaves the file untouched", () => {
    writeOnDisk({ activeAssistant: null, assistants: [entry] });
    const before = fs.readFileSync(lockfilePath, "utf-8");
    holdLock();

    expect(() =>
      saveLockfileAssistant({ assistantId: "asst_2", cloud: "local" }),
    ).toThrow();
    expect(fs.readFileSync(lockfilePath, "utf-8")).toBe(before);
  });

  test("platform replace refuses with 423 and leaves the file untouched", () => {
    writeOnDisk({ activeAssistant: null, assistants: [entry] });
    const before = fs.readFileSync(lockfilePath, "utf-8");
    holdLock();

    const result = replaceCloudAssistants(lockfilePath, [
      { assistantId: "asst_p", cloud: "cloud", runtimeUrl: "http://p" },
    ]);

    expect(result).toMatchObject({ ok: false, status: 423 });
    expect(fs.readFileSync(lockfilePath, "utf-8")).toBe(before);
  });

  test("a successful rename leaves no lock dir behind", () => {
    writeOnDisk({ activeAssistant: null, assistants: [entry] });

    const result = renameLockfileAssistantIfPresent(
      lockfilePath,
      "asst_1",
      "Renamed",
    );

    expect(result.ok).toBe(true);
    expect(fs.existsSync(`${lockfilePath}.lock`)).toBe(false);
  });
});

describe("replaceCloudAssistants", () => {
  test("rejects a renderer sync that tries to create a paired entry", () => {
    writeOnDisk({
      activeAssistant: "asst_local",
      assistants: [
        { assistantId: "asst_local", cloud: "local", runtimeUrl: "http://l" },
      ],
    });

    expect(
      replaceCloudAssistants(lockfilePath, [
        {
          assistantId: "asst_local",
          paired: true,
        },
      ]),
    ).toMatchObject({ ok: false, status: 403 });
    expect(readOnDisk()).toEqual({
      activeAssistant: "asst_local",
      assistants: [
        { assistantId: "asst_local", cloud: "local", runtimeUrl: "http://l" },
      ],
    });
  });

  // `onboardedAt` is recorded by the client and unknown to the cloud, so the
  // rows a sync builds from the API never carry it. Dropping it here would let
  // a routine session refresh erase the completion record.
  test("carries an existing onboardedAt onto the replacement row", () => {
    writeOnDisk({
      activeAssistant: "asst_p",
      assistants: [
        {
          assistantId: "asst_p",
          cloud: "cloud",
          onboardedAt: "2026-08-01T00:00:00.000Z",
        },
      ],
    });

    const result = replaceCloudAssistants(lockfilePath, [
      { assistantId: "asst_p", cloud: "cloud" },
    ]);

    expect(result.ok).toBe(true);
    expect(readOnDisk().assistants).toEqual([
      {
        assistantId: "asst_p",
        cloud: "cloud",
        onboardedAt: "2026-08-01T00:00:00.000Z",
      },
    ]);
  });

  test("an incoming onboardedAt wins over the stored one", () => {
    writeOnDisk({
      activeAssistant: null,
      assistants: [
        {
          assistantId: "asst_p",
          cloud: "cloud",
          onboardedAt: "2026-08-01T00:00:00.000Z",
        },
      ],
    });

    replaceCloudAssistants(lockfilePath, [
      {
        assistantId: "asst_p",
        cloud: "cloud",
        onboardedAt: "2026-08-31T00:00:00.000Z",
      },
    ]);

    expect(
      (readOnDisk().assistants as Array<Record<string, unknown>>)[0]
        ?.onboardedAt,
    ).toBe("2026-08-31T00:00:00.000Z");
  });

  test("a retired-then-recreated id does not inherit a stale stamp from another entry", () => {
    writeOnDisk({
      activeAssistant: null,
      assistants: [
        {
          assistantId: "asst_a",
          cloud: "cloud",
          onboardedAt: "2026-08-01T00:00:00.000Z",
        },
      ],
    });

    replaceCloudAssistants(lockfilePath, [
      { assistantId: "asst_b", cloud: "cloud" },
    ]);

    expect(readOnDisk().assistants).toEqual([
      { assistantId: "asst_b", cloud: "cloud" },
    ]);
  });

  test("replaces platform assistants while keeping local ones and unknown fields", () => {
    writeOnDisk({
      schemaVersion: 99,
      activeAssistant: "asst_local",
      assistants: [
        { assistantId: "asst_local", cloud: "local", runtimeUrl: "http://l" },
        {
          assistantId: "asst_old_platform",
          cloud: "cloud",
        },
      ],
    });

    const result = replaceCloudAssistants(lockfilePath, [
      {
        assistantId: "asst_new_platform",
        cloud: "cloud",
      },
    ]);

    expect(result.ok).toBe(true);

    const onDisk = readOnDisk();
    expect(onDisk.schemaVersion).toBe(99);
    const ids = (onDisk.assistants as Array<Record<string, unknown>>).map(
      (a) => a.assistantId,
    );
    expect(ids).toEqual(["asst_local", "asst_new_platform"]);
  });

  test("a sync scoped to one org preserves another org's platform entries", () => {
    writeOnDisk({
      activeAssistant: null,
      assistants: [
        {
          assistantId: "asst_org_a",
          cloud: "cloud",
          organizationId: "org_a",
        },
        {
          assistantId: "asst_org_b_old",
          cloud: "cloud",
          organizationId: "org_b",
        },
      ],
    });

    replaceCloudAssistants(
      lockfilePath,
      [
        {
          assistantId: "asst_org_b_new",
          cloud: "cloud",
          organizationId: "org_b",
        },
      ],
      "org_b",
    );

    const ids = (readOnDisk().assistants as Array<Record<string, unknown>>).map(
      (a) => a.assistantId,
    );
    // Org A survives; Org B's stale entry is replaced by the new one.
    expect(ids).toEqual(["asst_org_a", "asst_org_b_new"]);
  });

  test("de-duplicates a legacy no-org entry that shares an id with the new list", () => {
    writeOnDisk({
      activeAssistant: null,
      assistants: [
        // Legacy platform entry with no organizationId, same id as the sync.
        { assistantId: "asst_dup", cloud: "cloud" },
      ],
    });

    replaceCloudAssistants(
      lockfilePath,
      [
        {
          assistantId: "asst_dup",
          cloud: "cloud",
          organizationId: "org_a",
        },
      ],
      "org_a",
    );

    const assistants = readOnDisk().assistants as Array<
      Record<string, unknown>
    >;
    expect(assistants).toHaveLength(1);
    expect(assistants[0]).toMatchObject({
      assistantId: "asst_dup",
      organizationId: "org_a",
    });
  });

  test("full-replaces all platform entries when no org is given (legacy)", () => {
    writeOnDisk({
      activeAssistant: null,
      assistants: [
        {
          assistantId: "asst_org_a",
          cloud: "cloud",
          organizationId: "org_a",
        },
        {
          assistantId: "asst_org_b",
          cloud: "cloud",
          organizationId: "org_b",
        },
      ],
    });

    replaceCloudAssistants(lockfilePath, [
      {
        assistantId: "asst_new",
        cloud: "cloud",
      },
    ]);

    const ids = (readOnDisk().assistants as Array<Record<string, unknown>>).map(
      (a) => a.assistantId,
    );
    expect(ids).toEqual(["asst_new"]);
  });

  test("local entries always survive an org-scoped sync", () => {
    writeOnDisk({
      activeAssistant: null,
      assistants: [
        { assistantId: "asst_local", cloud: "local", runtimeUrl: "http://l" },
        {
          assistantId: "asst_org_a",
          cloud: "cloud",
          organizationId: "org_a",
        },
      ],
    });

    replaceCloudAssistants(
      lockfilePath,
      [
        {
          assistantId: "asst_org_a_new",
          cloud: "cloud",
          organizationId: "org_a",
        },
      ],
      "org_a",
    );

    const ids = (readOnDisk().assistants as Array<Record<string, unknown>>).map(
      (a) => a.assistantId,
    );
    expect(ids).toEqual(["asst_local", "asst_org_a_new"]);
  });

  test("keeps activeAssistant when it still resolves after an org-scoped sync", () => {
    writeOnDisk({
      activeAssistant: "asst_org_b_old",
      assistants: [
        {
          assistantId: "asst_org_b_old",
          cloud: "cloud",
          organizationId: "org_b",
        },
      ],
    });

    replaceCloudAssistants(
      lockfilePath,
      [
        {
          assistantId: "asst_org_a",
          cloud: "cloud",
          organizationId: "org_a",
        },
      ],
      "org_a",
    );

    // Org B's entry (and the active id pointing at it) survives the org-A sync.
    expect(readOnDisk().activeAssistant).toBe("asst_org_b_old");
  });

  test("clears activeAssistant when the active id no longer exists", () => {
    writeOnDisk({
      activeAssistant: "asst_old_platform",
      assistants: [
        {
          assistantId: "asst_old_platform",
          cloud: "cloud",
        },
      ],
    });

    replaceCloudAssistants(lockfilePath, [
      {
        assistantId: "asst_new_platform",
        cloud: "cloud",
      },
    ]);

    expect(readOnDisk().activeAssistant).toBeNull();
  });
});

describe("createLockfileAssistant", () => {
  test("create-only: an existing entry is never merged into", () => {
    // Even an id claimed between a caller's check and this write is refused
    // rather than merged into, so a registration cannot change an existing
    // assistant's remote setting.
    saveLockfileAssistant({
      assistantId: "taken",
      name: "Mine",
      cloud: "local",
      port: 7821,
    });
    expect(
      createLockfileAssistant({
        assistantId: "taken",
        name: "paired (10.0.0.5:7830)",
        cloud: "custom",
        ipAddress: "10.0.0.5",
        port: 7830,
      }),
    ).toBe(false);
    expect(readOnDisk().assistants).toEqual([
      { assistantId: "taken", name: "Mine", cloud: "local", port: 7821 },
    ]);
  });
});
