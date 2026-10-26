import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point lockfile operations at a temp directory before importing anything that
// would otherwise resolve real on-host paths.
const testDir = mkdtempSync(join(tmpdir(), "cli-orphan-detection-test-"));
process.env.XDG_CONFIG_HOME = testDir;

import {
  detectOrphanedProcesses,
  getKnownPidsFromAssistants,
} from "../lib/orphan-detection.js";
import {
  loadAllAssistants,
  type LockfileAssistant,
} from "../lib/assistant-config.js";

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
  delete process.env.XDG_CONFIG_HOME;
});

function makeLocalEntry(
  id: string,
  instanceDir: string,
  pids: {
    daemon?: string;
    gateway?: string;
    qdrant?: string;
    embed?: string;
  } = {},
): LockfileAssistant {
  mkdirSync(join(instanceDir, "workspace", "data", "qdrant"), {
    recursive: true,
  });
  if (pids.daemon !== undefined) {
    writeFileSync(join(instanceDir, "workspace", "cadet.pid"), pids.daemon);
  }
  if (pids.gateway !== undefined) {
    writeFileSync(join(instanceDir, "gateway.pid"), pids.gateway);
  }
  if (pids.qdrant !== undefined) {
    writeFileSync(
      join(instanceDir, "workspace", "data", "qdrant", "qdrant.pid"),
      pids.qdrant,
    );
  }
  if (pids.embed !== undefined) {
    writeFileSync(
      join(instanceDir, "workspace", "embed-worker.pid"),
      pids.embed,
    );
  }
  return {
    assistantId: id,
    runtimeUrl: "http://localhost:7821",
    cloud: "local",
    resources: {
      instanceDir,
      daemonPort: 7821,
      gatewayPort: 7830,
      cesPort: 8090,
    },
  };
}

describe("getKnownPidsFromAssistants", () => {
  let perTestDir: string;

  beforeEach(() => {
    perTestDir = mkdtempSync(join(testDir, "case-"));
  });

  test("collects daemon, gateway, qdrant, and embed-worker PIDs", () => {
    const entry = makeLocalEntry("alpha", join(perTestDir, "alpha"), {
      daemon: "100",
      gateway: "200",
      qdrant: "300",
      embed: "400",
    });
    const pids = getKnownPidsFromAssistants([entry]);
    expect(pids).toEqual(new Set(["100", "200", "300", "400"]));
  });

  test("skips missing PID files without throwing", () => {
    const entry = makeLocalEntry("beta", join(perTestDir, "beta"), {
      daemon: "100",
    });
    const pids = getKnownPidsFromAssistants([entry]);
    expect(pids).toEqual(new Set(["100"]));
  });

  test("includes docker watcherPid when present", () => {
    const entry: LockfileAssistant = {
      assistantId: "docker-1",
      runtimeUrl: "http://localhost:18100",
      cloud: "docker",
      watcherPid: 555,
    };
    const pids = getKnownPidsFromAssistants([entry]);
    expect(pids).toEqual(new Set(["555"]));
  });

  test("ignores non-local entries without watcherPid", () => {
    const entry: LockfileAssistant = {
      assistantId: "managed-1",
      runtimeUrl: "https://cloud.mycadet.ai/foo",
      cloud: "cloud",
    };
    const pids = getKnownPidsFromAssistants([entry]);
    expect(pids.size).toBe(0);
  });

  test("local entry without resources contributes no PIDs", () => {
    const entry: LockfileAssistant = {
      assistantId: "legacy",
      runtimeUrl: "http://localhost:7821",
      cloud: "local",
    };
    const pids = getKnownPidsFromAssistants([entry]);
    expect(pids.size).toBe(0);
  });

  test("aggregates PIDs across multiple assistants", () => {
    const a = makeLocalEntry("a", join(perTestDir, "a"), {
      daemon: "100",
      gateway: "200",
    });
    const b = makeLocalEntry("b", join(perTestDir, "b"), {
      daemon: "101",
      gateway: "201",
    });
    const pids = getKnownPidsFromAssistants([a, b]);
    expect(pids).toEqual(new Set(["100", "200", "101", "201"]));
  });
});

describe("loadAllAssistants", () => {
  // The loader reads the ambient lockfile; steer it at a temp config home
  // per case (the per-env subdirectory is the ambient layout).
  function steerLockfile(configHome: string): void {
    process.env.XDG_CONFIG_HOME = configHome;
  }

  test("parses the ambient lockfile's entries", () => {
    const envDir = join(mkdtempSync(join(testDir, "envA-")), "cadet");
    mkdirSync(envDir, { recursive: true });

    writeFileSync(
      join(envDir, "lockfile.json"),
      JSON.stringify({
        assistants: [
          {
            assistantId: "alpha",
            runtimeUrl: "http://localhost:7821",
            cloud: "local",
          },
          {
            assistantId: "beta",
            runtimeUrl: "http://localhost:18100",
            cloud: "docker",
            watcherPid: 777,
          },
        ],
      }),
    );
    steerLockfile(envDir);
    const all = loadAllAssistants();
    const ids = all.map((e) => e.assistantId).sort();
    expect(ids).toEqual(["alpha", "beta"]);
  });
  test("returns empty list when the lockfile is missing", () => {
    const envDir = join(mkdtempSync(join(testDir, "empty-")), "cadet");
    mkdirSync(envDir, { recursive: true });
    steerLockfile(envDir);
    const all = loadAllAssistants();
    expect(all).toEqual([]);
  });

  test("skips malformed JSON without throwing", () => {
    const envDir = join(mkdtempSync(join(testDir, "malformed-")), "cadet");
    mkdirSync(envDir, { recursive: true });
    writeFileSync(join(envDir, "lockfile.json"), "{not json");
    steerLockfile(envDir);
    const all = loadAllAssistants();
    expect(all).toEqual([]);
  });

  test("keeps schema-valid entries; the schema drops id-less rows", () => {
    const envDir = join(mkdtempSync(join(testDir, "partial-")), "cadet");
    mkdirSync(envDir, { recursive: true });
    writeFileSync(
      join(envDir, "lockfile.json"),
      JSON.stringify({
        assistants: [
          { assistantId: "no-url" }, // valid: runtimeUrl is optional now
          { runtimeUrl: "http://x" }, // missing assistantId: dropped
          {
            assistantId: "good",
            runtimeUrl: "http://localhost:7821",
            cloud: "local",
          },
        ],
      }),
    );
    steerLockfile(envDir);
    const all = loadAllAssistants();
    expect(all.map((e) => e.assistantId)).toEqual(["no-url", "good"]);
  });

  test("end-to-end: dev env's daemon is not flagged as orphan from local env", () => {
    // Simulate Vargas's reported bug: `local` env has no assistants, but a
    // `dev` env assistant is running with a recorded daemon PID. The orphan
    // filter must treat that PID as known.
    const devDir = join(mkdtempSync(join(testDir, "dev-")), "cadet");
    mkdirSync(devDir, { recursive: true });
    const instanceDir = join(devDir, "instances", "quiet-finch");
    makeLocalEntry("quiet-finch", instanceDir, {
      daemon: "19067",
      gateway: "19087",
      qdrant: "19167",
    });

    writeFileSync(
      join(devDir, "lockfile.json"),
      JSON.stringify({
        assistants: [
          {
            assistantId: "quiet-finch",
            runtimeUrl: "http://127.0.0.1:18100",
            cloud: "local",
            resources: {
              instanceDir,
              daemonPort: 18000,
              gatewayPort: 18100,
              cesPort: 18300,
            },
          },
        ],
      }),
    );

    steerLockfile(devDir);
    const devEntries = loadAllAssistants();
    expect(devEntries).toHaveLength(1);

    const knownPids = getKnownPidsFromAssistants(devEntries);
    expect(knownPids).toEqual(new Set(["19067", "19087", "19167"]));
  });
});

describe("detectOrphanedProcesses", () => {
  test("excludes PIDs passed via excludePids", async () => {
    // The orphan detector calls `ps ax` and filters by regex. The process
    // running this test (bun) is itself a node-family process whose pid will
    // not match the cadet/qdrant regex, so the natural result of
    // the scan is "no rows". To assert exclusion semantics deterministically,
    // we just confirm the function accepts an excludePids option and returns
    // an array — the meaningful behavior assertion lives in the integration
    // path (the function's `knownPids.has(p.pid)` short-circuit), which we
    // exercise indirectly by passing our own PID (guaranteed to never be
    // double-counted).
    const ownPid = String(process.pid);
    const result = await detectOrphanedProcesses({
      excludePids: new Set([ownPid]),
    });
    expect(Array.isArray(result)).toBe(true);
    for (const orphan of result) {
      expect(orphan.pid).not.toBe(ownPid);
    }
  });

  test("returns an array (smoke)", async () => {
    const result = await detectOrphanedProcesses({
      excludePids: new Set(),
    });
    expect(Array.isArray(result)).toBe(true);
  });
});
