import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  afterAll,
  spyOn,
} from "bun:test";
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
process.env.CADET_LOCKFILE_DIR = testDir;

import {
  loadLatestAssistant,
  findAssistantByName,
  formatAssistantLookupError,
  getAssistantDisplayName,
  lookupAssistantByIdentifier,
  removeAssistantEntry,
  loadAllAssistants,
  resolveTargetAssistant,
  saveAssistantEntry,
  getActiveAssistant,
  type AssistantEntry,
} from "../lib/assistant-config.js";

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
  delete process.env.CADET_LOCKFILE_DIR;
});

function writeLockfile(data: unknown): void {
  writeFileSync(
    join(testDir, "lockfile.json"),
    JSON.stringify(data, null, 2),
  );
}

const makeEntry = (
  id: string,
  runtimeUrl = "http://localhost:7821",
  extra?: Partial<AssistantEntry>,
): AssistantEntry => ({
  assistantId: id,
  runtimeUrl,
  cloud: "local",
  ...extra,
});

describe("assistant-config", () => {
  beforeEach(() => {
    // Reset the canonical lockfile between tests
    try {
      rmSync(join(testDir, "lockfile.json"));
    } catch {
      // file may not exist
    }
  });

  test("loadAllAssistants returns empty array when no lockfile exists", () => {
    expect(loadAllAssistants()).toEqual([]);
  });

  test("loadAllAssistants returns empty array for malformed lockfile", () => {
    writeFileSync(join(testDir, "lockfile.json"), "not json");
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

  test("saveAssistantEntry and loadAllAssistants round-trip", () => {
    const entry = makeEntry("test-1");
    saveAssistantEntry(entry);
    const all = loadAllAssistants();
    expect(all).toHaveLength(1);
    expect(all[0].assistantId).toBe("test-1");
  });

  test("saveAssistantEntry writes under the advisory lock and cleans it up", () => {
    saveAssistantEntry(makeEntry("locked-1"));
    expect(loadAllAssistants()).toHaveLength(1);
    // The shared `${lockfilePath}.lock` key hosts contend on is released.
    expect(existsSync(join(testDir, "lockfile.json.lock"))).toBe(false);
  });

  test("saveAssistantEntry breaks a stale lock and still lands the write", () => {
    const lockDir = join(testDir, "lockfile.json.lock");
    mkdirSync(lockDir);
    const past = new Date(Date.now() - 60_000);
    utimesSync(lockDir, past, past);

    saveAssistantEntry(makeEntry("stale-lock-1"));
    expect(loadAllAssistants()).toHaveLength(1);
    expect(existsSync(lockDir)).toBe(false);
  });

  test("saveAssistantEntry fails fast without writing when another holder is fresh", () => {
    const lockDir = join(testDir, "lockfile.json.lock");
    mkdirSync(lockDir);
    try {
      const start = Date.now();
      expect(() => saveAssistantEntry(makeEntry("contended-1"))).toThrow(
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

  test("getAssistantDisplayName prefers the platform name", () => {
    expect(
      getAssistantDisplayName(
        makeEntry("assistant-1", undefined, { name: "Alice" }),
      ),
    ).toBe("Alice");
    expect(getAssistantDisplayName(makeEntry("assistant-3"))).toBe(
      "assistant-3",
    );
  });

  test("findAssistantByName only resolves assistant IDs", () => {
    writeLockfile({
      assistants: [
        makeEntry("assistant-1", "http://localhost:7821", { name: "Alice" }),
        makeEntry("assistant-2", "http://localhost:7822", { name: "Bob" }),
      ],
    });

    expect(findAssistantByName("Alice")).toBeNull();
    expect(findAssistantByName("assistant-1")?.assistantId).toBe("assistant-1");
  });

  test("lookupAssistantByIdentifier resolves a unique display name", () => {
    writeLockfile({
      assistants: [
        makeEntry("assistant-1", "http://localhost:7821", { name: "Alice" }),
        makeEntry("assistant-2", "http://localhost:7822", { name: "Bob" }),
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
        makeEntry("Alice", "http://localhost:7821", { name: "Primary" }),
        makeEntry("assistant-2", "http://localhost:7822", { name: "Alice" }),
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
        makeEntry("assistant-1", "http://localhost:7821", { name: "Alice" }),
        makeEntry("assistant-2", "http://localhost:7822", { name: "Alice" }),
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

  test("removeAssistantEntry removes matching entry", () => {
    writeLockfile({
      assistants: [makeEntry("a"), makeEntry("b"), makeEntry("c")],
    });
    removeAssistantEntry("b");
    const all = loadAllAssistants();
    expect(all).toHaveLength(2);
    expect(all.map((e) => e.assistantId)).toEqual(["a", "c"]);
  });

  test("removeAssistantEntry reassigns activeAssistant to remaining entry", () => {
    writeLockfile({
      assistants: [makeEntry("a"), makeEntry("b")],
      activeAssistant: "a",
    });
    removeAssistantEntry("a");
    expect(getActiveAssistant()).toBe("b");
    expect(loadAllAssistants()).toHaveLength(1);
  });

  test("removeAssistantEntry clears activeAssistant when no entries remain", () => {
    writeLockfile({
      assistants: [makeEntry("only")],
      activeAssistant: "only",
    });
    removeAssistantEntry("only");
    expect(getActiveAssistant()).toBeNull();
    expect(loadAllAssistants()).toHaveLength(0);
  });

  test("removeAssistantEntry preserves activeAssistant when removing a different entry", () => {
    writeLockfile({
      assistants: [makeEntry("a"), makeEntry("b"), makeEntry("c")],
      activeAssistant: "a",
    });
    removeAssistantEntry("b");
    expect(getActiveAssistant()).toBe("a");
    expect(loadAllAssistants()).toHaveLength(2);
  });

  test("loadLatestAssistant returns null when empty", () => {
    expect(loadLatestAssistant()).toBeNull();
  });

  test("loadLatestAssistant returns most recently hatched entry", () => {
    writeLockfile({
      assistants: [
        makeEntry("old", "http://localhost:7821", {
          hatchedAt: "2024-01-01T00:00:00Z",
        }),
        makeEntry("new", "http://localhost:7822", {
          hatchedAt: "2025-06-15T00:00:00Z",
        }),
        makeEntry("mid", "http://localhost:7823", {
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
        makeEntry("with-date", "http://localhost:7822", {
          hatchedAt: "2025-01-01T00:00:00Z",
        }),
      ],
    });
    const latest = loadLatestAssistant();
    expect(latest!.assistantId).toBe("with-date");
  });

  test("loadAllAssistants filters out entries missing required fields", () => {
    writeLockfile({
      assistants: [
        makeEntry("valid"),
        { cloud: "local" }, // missing assistantId and runtimeUrl
        { assistantId: "no-url", cloud: "local" }, // missing runtimeUrl
      ],
    });
    const all = loadAllAssistants();
    expect(all).toHaveLength(1);
    expect(all[0].assistantId).toBe("valid");
  });
});

describe("env-scoped lockfile and migration", () => {
  test("readLockfile/writeLockfile use $XDG_CONFIG_HOME/cadet-<env>/lockfile.json in non-prod", () => {
    // The env package's xdgConfigHome() reads process.env.XDG_CONFIG_HOME
    // fresh on every call, so redirecting via that env var works without
    // mocking `os`. We temporarily unset CADET_LOCKFILE_DIR so the env
    // package falls through to getConfigDir(env).
    const prevEnv = process.env.CADET_ENVIRONMENT;
    const prevXdgConfig = process.env.XDG_CONFIG_HOME;
    const prevLockDir = process.env.CADET_LOCKFILE_DIR;
    const xdgConfigHome = mkdtempSync(join(tmpdir(), "cli-xdg-config-"));
    process.env.CADET_ENVIRONMENT = "dev";
    process.env.XDG_CONFIG_HOME = xdgConfigHome;
    delete process.env.CADET_LOCKFILE_DIR;
    try {
      // WHEN we save an assistant entry (which triggers writeLockfile)
      saveAssistantEntry({
        assistantId: "dev-env-bot",
        runtimeUrl: "http://localhost:7830",
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
      if (prevLockDir !== undefined) {
        process.env.CADET_LOCKFILE_DIR = prevLockDir;
      }
      rmSync(xdgConfigHome, { recursive: true, force: true });
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
      rmSync(join(testDir, "lockfile.json"), { force: true });
      rmSync(join(testDir, ".cadet.lock.json"), { force: true });

      saveAssistantEntry({
        assistantId: "prod-bot",
        runtimeUrl: "http://localhost:7830",
        cloud: "local",
      });

      const raw = JSON.parse(readFileSync(join(testDir, "lockfile.json"), "utf-8"));
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

describe("cross-environment hint on resolution failure", () => {
  let dataHome: string;
  let prevXdg: string | undefined;
  let prevEnv: string | undefined;

  beforeEach(() => {
    prevXdg = process.env.XDG_DATA_HOME;
    prevEnv = process.env.CADET_ENVIRONMENT;
    dataHome = mkdtempSync(join(tmpdir(), "cli-config-xdg-"));
    process.env.XDG_DATA_HOME = dataHome;
    // Pin the current env to production so the detector skips it and the hint
    // copy is deterministic. The current-env lockfile is emptied so resolution
    // genuinely finds nothing.
    process.env.CADET_ENVIRONMENT = "production";
    rmSync(join(testDir, "lockfile.json"), { force: true });
    rmSync(join(testDir, ".cadet.lock.json"), { force: true });
    rmSync(join(testDir, ".cadet.lockfile.json"), { force: true });
  });

  afterEach(() => {
    if (prevXdg === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = prevXdg;
    }
    if (prevEnv === undefined) {
      delete process.env.CADET_ENVIRONMENT;
    } else {
      process.env.CADET_ENVIRONMENT = prevEnv;
    }
    rmSync(dataHome, { recursive: true, force: true });
  });

  // A dev-env assistant lives under the dev data dir, invisible to this
  // production CLI — the exact split the hint explains.
  function seedDevAssistant(): void {
    mkdirSync(join(dataHome, "cadet-dev", "assistants", "dev-bot"), {
      recursive: true,
    });
  }

  function captureResolveTargetAssistantError(): string {
    const errors: string[] = [];
    const errorSpy = spyOn(console, "error").mockImplementation(
      (...args: unknown[]) => {
        errors.push(args.join(" "));
      },
    );
    const exitSpy = spyOn(process, "exit").mockImplementation(((
      _code?: number,
    ) => {
      throw new Error("exit");
    }) as typeof process.exit);
    try {
      expect(() => resolveTargetAssistant()).toThrow("exit");
    } finally {
      errorSpy.mockRestore();
      exitSpy.mockRestore();
    }
    return errors.join("\n");
  }

  test("formatAssistantLookupError appends the hint when another env has assistants", () => {
    seedDevAssistant();
    const msg = formatAssistantLookupError("ghost", { status: "not_found" });
    expect(msg).toContain("No assistant found with name or ID 'ghost'.");
    expect(msg).toContain("Install cadet Command");
  });

  test("formatAssistantLookupError stays bare when no other env has assistants", () => {
    // dataHome is empty — detection finds nothing, so the message is intact.
    const msg = formatAssistantLookupError("ghost", { status: "not_found" });
    expect(msg).toBe("No assistant found with name or ID 'ghost'.");
  });

  test("ambiguous lookup never gets the hint", () => {
    seedDevAssistant();
    const msg = formatAssistantLookupError("Alice", {
      status: "ambiguous",
      matches: [
        makeEntry("assistant-1", "http://localhost:7821", { name: "Alice" }),
        makeEntry("assistant-2", "http://localhost:7822", { name: "Alice" }),
      ],
    });
    expect(msg).not.toContain("Install cadet Command");
  });

  test("resolveTargetAssistant zero-assistants error carries the hint", () => {
    seedDevAssistant();
    const combined = captureResolveTargetAssistantError();
    expect(combined).toContain("No assistant found. Run 'cadet hatch' first.");
    expect(combined).toContain("Install cadet Command");
  });

  test("resolveTargetAssistant zero-assistants error stays bare without other envs", () => {
    const combined = captureResolveTargetAssistantError();
    expect(combined).toContain("No assistant found. Run 'cadet hatch' first.");
    expect(combined).not.toContain("Install cadet Command");
  });
});
