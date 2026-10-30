import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point lockfile operations at a temp directory
const testDir = mkdtempSync(join(tmpdir(), "cli-assistant-config-test-"));
const prevConfigHome = process.env.XDG_CONFIG_HOME;
process.env.XDG_CONFIG_HOME = testDir;

import {
  loadLatestAssistant,
  findAssistantByName,
  formatAssistantLookupError,
  getAssistantDisplayName,
  lookupAssistantByIdentifier,
  removeLockfileAssistant,
  loadAllAssistants,
  getActiveAssistant,
  type LockfileAssistant,
} from "../lib/assistant-config.js";
import { saveLockfileAssistant } from "@mycadet/local-mode";

afterAll(() => {
  if (prevConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = prevConfigHome;
  }
  rmSync(testDir, { recursive: true, force: true });
});

function writeLockfile(data: unknown): void {
  mkdirSync(join(testDir, "cadet"), { recursive: true });
  writeFileSync(
    join(testDir, "cadet", "lockfile.json"),
    JSON.stringify(data, null, 2),
  );
}

const makeEntry = (
  id: string,
  extra?: Partial<LockfileAssistant>,
): LockfileAssistant =>
  ({
    assistantId: id,
    cloud: "local",
    ...extra,
  }) as LockfileAssistant;

describe("assistant-config", () => {
  beforeEach(() => {
    // Reset every environment's lockfile between tests — loadAllAssistants
    // reads the union, so a stale non-prod entry would leak into counts.
    for (const envDir of [
      "cadet",
      "cadet-dev",
      "cadet-local",
      "cadet-staging",
    ]) {
      rmSync(join(testDir, envDir, "lockfile.json"), { force: true });
    }
  });

  test("loadAllAssistants returns empty array when no lockfile exists", () => {
    expect(loadAllAssistants()).toEqual([]);
  });

  test("loadAllAssistants returns empty array for malformed lockfile", () => {
    mkdirSync(join(testDir, "cadet"), { recursive: true });
    writeFileSync(join(testDir, "cadet", "lockfile.json"), "not json");
    expect(loadAllAssistants()).toEqual([]);
  });

  test("legacy home-level lockfile names are no longer read (the migration moves them into place)", () => {
    // A pre-move home-level file alone must NOT be picked up — the
    // migration tooling is what moves it to the canonical config-dir path.
    writeFileSync(
      join(testDir, ".cadet.lock.json"),
      JSON.stringify({ assistants: [makeEntry("legacy-1")] }, null, 2),
    );
    expect(loadAllAssistants()).toEqual([]);
  });

  test("loadAllAssistants returns empty array when assistants key is missing", () => {
    writeLockfile({ someOtherKey: true });
    expect(loadAllAssistants()).toEqual([]);
  });

  test("saveLockfileAssistant and loadAllAssistants round-trip", () => {
    const entry = makeEntry("test-1");
    saveLockfileAssistant(entry);
    const all = loadAllAssistants();
    expect(all).toHaveLength(1);
    expect(all[0].assistantId).toBe("test-1");
  });

  test("saveLockfileAssistant writes under the advisory lock and cleans it up", () => {
    saveLockfileAssistant(makeEntry("locked-1"));
    expect(loadAllAssistants()).toHaveLength(1);
    // The shared `${lockfilePath}.lock` key hosts contend on is released.
    expect(existsSync(join(testDir, "cadet", "lockfile.json.lock"))).toBe(
      false,
    );
  });

  test("saveLockfileAssistant breaks a stale lock and still lands the write", () => {
    const lockDir = join(testDir, "cadet", "lockfile.json.lock");
    mkdirSync(lockDir, { recursive: true });
    const past = new Date(Date.now() - 60_000);
    utimesSync(lockDir, past, past);

    saveLockfileAssistant(makeEntry("stale-lock-1"));
    expect(loadAllAssistants()).toHaveLength(1);
    expect(existsSync(lockDir)).toBe(false);
  });

  test("saveLockfileAssistant fails fast without writing when another holder is fresh", () => {
    const lockDir = join(testDir, "cadet", "lockfile.json.lock");
    mkdirSync(lockDir, { recursive: true });
    try {
      const start = Date.now();
      expect(() => saveLockfileAssistant(makeEntry("contended-1"))).toThrow(
        /Timed out acquiring lockfile lock/,
      );
      expect(Date.now() - start).toBeLessThan(2_000);
      expect(loadAllAssistants()).toEqual([]);
    } finally {
      rmSync(lockDir, { recursive: true, force: true });
    }
  });

  test("findAssistantByName returns matching entry", () => {
    writeLockfile({
      assistants: [makeEntry("alpha"), makeEntry("beta")],
    });
    const result = findAssistantByName("beta");
    expect(result).not.toBeNull();
    expect(result!.assistantId).toBe("beta");
  });

  test("getAssistantDisplayName prefers the entry's name", () => {
    expect(
      getAssistantDisplayName(makeEntry("assistant-1", { name: "Alice" })),
    ).toBe("Alice");
    expect(getAssistantDisplayName(makeEntry("assistant-3"))).toBe(
      "assistant-3",
    );
  });

  test("findAssistantByName only resolves assistant IDs", () => {
    writeLockfile({
      assistants: [
        makeEntry("assistant-1", { name: "Alice" }),
        makeEntry("assistant-2", { name: "Bob" }),
      ],
    });

    expect(findAssistantByName("Alice")).toBeNull();
    expect(findAssistantByName("assistant-1")?.assistantId).toBe("assistant-1");
  });

  test("lookupAssistantByIdentifier resolves a unique display name", () => {
    writeLockfile({
      assistants: [
        makeEntry("assistant-1", { name: "Alice" }),
        makeEntry("assistant-2", { name: "Bob" }),
      ],
    });

    const result = lookupAssistantByIdentifier("Alice");
    expect(result.status).toBe("found");
    expect(result.status === "found" ? result.entry.assistantId : null).toBe(
      "assistant-1",
    );
  });

  test("assistant ID lookup wins over a display name match", () => {
    writeLockfile({
      assistants: [
        makeEntry("Alice", { name: "Primary" }),
        makeEntry("assistant-2", { name: "Alice" }),
      ],
    });

    const result = lookupAssistantByIdentifier("Alice");
    expect(result.status).toBe("found");
    expect(result.status === "found" ? result.entry.assistantId : null).toBe(
      "Alice",
    );
  });

  test("ambiguous display name lookup is explicit", () => {
    writeLockfile({
      assistants: [
        makeEntry("assistant-1", { name: "Alice" }),
        makeEntry("assistant-2", { name: "Alice" }),
      ],
    });

    const result = lookupAssistantByIdentifier("Alice");
    expect(result.status).toBe("ambiguous");
    expect(findAssistantByName("Alice")).toBeNull();
    expect(formatAssistantLookupError("Alice", result)).toContain(
      "assistant-1",
    );
    expect(formatAssistantLookupError("Alice", result)).toContain(
      "assistant-2",
    );
  });

  test("findAssistantByName returns null for non-existent name", () => {
    writeLockfile({ assistants: [makeEntry("alpha")] });
    expect(findAssistantByName("missing")).toBeNull();
  });

  test("removeLockfileAssistant removes matching entry", () => {
    writeLockfile({
      assistants: [makeEntry("a"), makeEntry("b"), makeEntry("c")],
    });
    removeLockfileAssistant("b");
    const all = loadAllAssistants();
    expect(all).toHaveLength(2);
    expect(all.map((e) => e.assistantId)).toEqual(["a", "c"]);
  });

  test("removeLockfileAssistant reassigns activeAssistant to remaining entry", () => {
    writeLockfile({
      assistants: [makeEntry("a"), makeEntry("b")],
      activeAssistant: "a",
    });
    removeLockfileAssistant("a");
    expect(getActiveAssistant()).toBe("b");
    expect(loadAllAssistants()).toHaveLength(1);
  });

  test("removeLockfileAssistant clears activeAssistant when no entries remain", () => {
    writeLockfile({
      assistants: [makeEntry("only")],
      activeAssistant: "only",
    });
    removeLockfileAssistant("only");
    expect(getActiveAssistant()).toBeNull();
    expect(loadAllAssistants()).toHaveLength(0);
  });

  test("removeLockfileAssistant preserves activeAssistant when removing a different entry", () => {
    writeLockfile({
      assistants: [makeEntry("a"), makeEntry("b"), makeEntry("c")],
      activeAssistant: "a",
    });
    removeLockfileAssistant("b");
    expect(getActiveAssistant()).toBe("a");
    expect(loadAllAssistants()).toHaveLength(2);
  });

  test("loadLatestAssistant returns null when empty", () => {
    expect(loadLatestAssistant()).toBeNull();
  });

  test("loadLatestAssistant returns most recently hatched entry", () => {
    writeLockfile({
      assistants: [
        makeEntry("old", {
          hatchedAt: "2024-01-01T00:00:00Z",
        }),
        makeEntry("new", {
          hatchedAt: "2025-06-15T00:00:00Z",
        }),
        makeEntry("mid", {
          hatchedAt: "2024-06-15T00:00:00Z",
        }),
      ],
    });
    const latest = loadLatestAssistant();
    expect(latest).not.toBeNull();
    expect(latest!.assistantId).toBe("new");
  });

  test("loadLatestAssistant handles entries without hatchedAt", () => {
    writeLockfile({
      assistants: [
        makeEntry("no-date"),
        makeEntry("with-date", {
          hatchedAt: "2025-01-01T00:00:00Z",
        }),
      ],
    });
    const latest = loadLatestAssistant();
    expect(latest!.assistantId).toBe("with-date");
  });

  test("loadAllAssistants returns every schema-valid entry", () => {
    writeLockfile({
      assistants: [
        makeEntry("valid"),
        { cloud: "local" }, // missing assistantId: the schema drops it
        { assistantId: "no-url", cloud: "local" }, // valid: runtimeUrl is optional
      ],
    });
    const all = loadAllAssistants();
    expect(all).toHaveLength(2);
    expect(all[0].assistantId).toBe("valid");
    expect(all[1].assistantId).toBe("no-url");
  });
});

describe("env-scoped lockfile and migration", () => {
  test("readLockfile/writeLockfile use $XDG_CONFIG_HOME/cadet-<env>/lockfile.json in non-prod", () => {
    // The env package's xdgConfigHome() reads process.env.XDG_CONFIG_HOME
    // fresh on every call, so redirecting via that env var works without
    // mocking `os`. The env package falls through to the ambient resolver.
    const prevEnv = process.env.CADET_ENVIRONMENT;
    const prevXdgConfig = process.env.XDG_CONFIG_HOME;
    const xdgConfigHome = mkdtempSync(join(tmpdir(), "cli-xdg-config-"));
    process.env.CADET_ENVIRONMENT = "dev";
    process.env.XDG_CONFIG_HOME = xdgConfigHome;
    try {
      // WHEN we save an assistant entry (which triggers writeLockfile)
      saveLockfileAssistant({
        assistantId: "dev-env-bot",
        cloud: "local",
      });

      // THEN the lockfile lives at the env-scoped XDG config path
      const expectedPath = join(xdgConfigHome, "cadet-dev", "lockfile.json");
      const raw = JSON.parse(readFileSync(expectedPath, "utf-8"));
      expect(raw.assistants).toHaveLength(1);
      expect(raw.assistants[0].assistantId).toBe("dev-env-bot");

      // AND readLockfile reads it back via loadAllAssistants()
      const all = loadAllAssistants();
      expect(all).toHaveLength(1);
      expect(all[0].assistantId).toBe("dev-env-bot");
    } finally {
      if (prevEnv !== undefined) {
        process.env.CADET_ENVIRONMENT = prevEnv;
      } else {
        delete process.env.CADET_ENVIRONMENT;
      }
      if (prevXdgConfig !== undefined) {
        process.env.XDG_CONFIG_HOME = prevXdgConfig;
      } else {
        delete process.env.XDG_CONFIG_HOME;
      }
      rmSync(xdgConfigHome, { recursive: true, force: true });
      // The union reader must not see this test's dev entry afterwards.
      rmSync(join(testDir, "cadet-dev", "lockfile.json"), { force: true });
    }
  });

  test("production writes land at the config-dir lockfile.json, never the legacy home-level name", () => {
    // With CADET_ENVIRONMENT unset, the env package resolves production,
    // whose canonical lockfile is the config-dir `lockfile.json` — the same
    // convention every environment uses. The home-level `.cadet.lock.json`
    // name is a read-only fallback and is never (re)created by writes.
    const prevEnv = process.env.CADET_ENVIRONMENT;
    delete process.env.CADET_ENVIRONMENT;
    try {
      // Clear any existing lockfile from earlier tests
      rmSync(join(testDir, "cadet", "lockfile.json"), { force: true });
      rmSync(join(testDir, ".cadet.lock.json"), { force: true });

      saveLockfileAssistant({
        assistantId: "prod-bot",
        cloud: "local",
      });

      const raw = JSON.parse(
        readFileSync(join(testDir, "cadet", "lockfile.json"), "utf-8"),
      );
      expect(raw.assistants).toHaveLength(1);
      expect(raw.assistants[0].assistantId).toBe("prod-bot");
      expect(existsSync(join(testDir, ".cadet.lock.json"))).toBe(false);
    } finally {
      if (prevEnv !== undefined) {
        process.env.CADET_ENVIRONMENT = prevEnv;
      }
    }
  });
});
