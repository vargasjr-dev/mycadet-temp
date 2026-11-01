import { describe, test, expect, beforeEach, afterAll, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Create a temp directory that acts as a fake home, so allocateLocalPlacement()
// never touches the real ~/.cadet directory.
const testDir = mkdtempSync(join(tmpdir(), "cli-multi-local-test-"));
process.env.XDG_CONFIG_HOME = testDir;

// Mock homedir() to return testDir — this isolates allocateLocalPlacement()
// which uses homedir() directly for instance directory creation.
await mockOsHomedir(() => () => testDir);

// Mock probePort so we control which ports appear in-use without touching the network
const probePortMock = mock<(port: number, host?: string) => Promise<boolean>>(
  () => Promise.resolve(false),
);
mock.module("../../../packages/local-mode/src/port-probe", () => ({
  probePort: probePortMock,
}));

import {
  resolveTargetAssistant,
  setActiveAssistant,
} from "../lib/assistant-config.js";
import { allocateLocalPlacement } from "@mycadet/local-mode";
import {
  getActiveAssistant,
  removeLockfileAssistant,
  saveLockfileAssistant,
} from "@mycadet/local-mode";
import { DEFAULT_DAEMON_PORT, DEFAULT_GATEWAY_PORT } from "../lib/constants.js";
import { mockOsHomedir } from "./helpers/os-mock.js";
import { makeEntry, readEntry } from "./helpers/lockfile-entry.js";

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
  delete process.env.XDG_CONFIG_HOME;
});

function writeLockfile(data: unknown): void {
  writeFileSync(
    join(testDir, "cadet", "lockfile.json"),
    JSON.stringify(data, null, 2),
  );
}

function readLockfileRaw(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(testDir, "cadet", "lockfile.json"), "utf-8"),
  ) as Record<string, unknown>;
}

function resetLockfile(): void {
  try {
    rmSync(join(testDir, "cadet", "lockfile.json"));
  } catch {
    // file may not exist
  }
  try {
    rmSync(join(testDir, ".cadet.lockfile.json"));
  } catch {
    // file may not exist
  }
}

describe("multi-local", () => {
  beforeEach(() => {
    resetLockfile();
    probePortMock.mockReset();
    probePortMock.mockImplementation(() => Promise.resolve(false));
  });

  describe("allocateLocalPlacement() produces non-conflicting ports", () => {
    test("first instance (prod) gets XDG multi-instance dir with default ports", async () => {
      // GIVEN XDG_DATA_HOME points at a scratch directory and no local
      // assistants exist in the lockfile
      const prevXdg = process.env.XDG_DATA_HOME;
      const xdgDataHome = mkdtempSync(join(tmpdir(), "cli-multi-xdg-data-"));
      process.env.XDG_DATA_HOME = xdgDataHome;
      try {
        // WHEN we allocate resources for the first instance
        const res = await allocateLocalPlacement("instance-a");

        // THEN it lands under the XDG multi-instance dir (no "first = home"
        // special case anymore)
        expect(res.instanceDir).toBe(
          join(xdgDataHome, "cadet", "assistants", "instance-a"),
        );

        // AND it gets the default ports since no other instances exist
        expect(res.daemonPort).toBe(DEFAULT_DAEMON_PORT);
        expect(res.port).toBe(DEFAULT_GATEWAY_PORT);
      } finally {
        if (prevXdg !== undefined) {
          process.env.XDG_DATA_HOME = prevXdg;
        } else {
          delete process.env.XDG_DATA_HOME;
        }
        rmSync(xdgDataHome, { recursive: true, force: true });
      }
    });

    test("first instance (dev) uses env-scoped multi-instance dir", async () => {
      // GIVEN CADET_ENVIRONMENT=dev and XDG_DATA_HOME set to scratch
      const prevEnv = process.env.CADET_ENVIRONMENT;
      const prevXdg = process.env.XDG_DATA_HOME;
      const xdgDataHome = mkdtempSync(join(tmpdir(), "cli-multi-xdg-dev-"));
      process.env.CADET_ENVIRONMENT = "dev";
      process.env.XDG_DATA_HOME = xdgDataHome;
      try {
        // WHEN we allocate resources for the first instance
        const res = await allocateLocalPlacement("instance-a");

        // THEN it lands under the env-scoped multi-instance dir
        expect(res.instanceDir).toBe(
          join(xdgDataHome, "cadet-dev", "assistants", "instance-a"),
        );
      } finally {
        if (prevEnv !== undefined) {
          process.env.CADET_ENVIRONMENT = prevEnv;
        } else {
          delete process.env.CADET_ENVIRONMENT;
        }
        if (prevXdg !== undefined) {
          process.env.XDG_DATA_HOME = prevXdg;
        } else {
          delete process.env.XDG_DATA_HOME;
        }
        rmSync(xdgDataHome, { recursive: true, force: true });
      }
    });

    test("allocation picks env-specific port bases for non-prod envs", async () => {
      // Each non-prod env sits in its own 1000-port window (see
      // @mycadet/environments seeds). Hatching under CADET_ENVIRONMENT=dev should
      // produce ports in the dev block (18000+), not the production defaults.
      const prevEnv = process.env.CADET_ENVIRONMENT;
      const prevXdg = process.env.XDG_DATA_HOME;
      const xdgDataHome = mkdtempSync(join(tmpdir(), "cli-multi-xdg-ports-"));
      process.env.CADET_ENVIRONMENT = "dev";
      process.env.XDG_DATA_HOME = xdgDataHome;
      try {
        const res = await allocateLocalPlacement("dev-a");
        expect(res.daemonPort).toBe(18000);
        expect(res.port).toBe(18100);
        expect(res.cesPort).toBe(18300);
      } finally {
        if (prevEnv !== undefined) {
          process.env.CADET_ENVIRONMENT = prevEnv;
        } else {
          delete process.env.CADET_ENVIRONMENT;
        }
        if (prevXdg !== undefined) {
          process.env.XDG_DATA_HOME = prevXdg;
        } else {
          delete process.env.XDG_DATA_HOME;
        }
        rmSync(xdgDataHome, { recursive: true, force: true });
      }
    });

    test("second instance gets distinct ports and dir when first instance is saved", async () => {
      // GIVEN a first local assistant already exists in the lockfile
      makeEntry({ assistantId: "instance-a" });

      // AND the default ports are occupied
      const occupiedPorts = new Set([
        DEFAULT_DAEMON_PORT,
        DEFAULT_GATEWAY_PORT,
      ]);
      probePortMock.mockImplementation((port: number) =>
        Promise.resolve(occupiedPorts.has(port)),
      );

      // WHEN we allocate resources for a second instance
      const b = await allocateLocalPlacement("instance-b");

      // THEN the second instance gets non-default ports
      if (b.daemonPort === undefined || b.port === undefined)
        throw new Error("expected a fully-allocated placement");
      expect(occupiedPorts.has(b.daemonPort)).toBe(false);
      expect(occupiedPorts.has(b.port)).toBe(false);

      // AND it gets its own dedicated instance directory
      expect(b.instanceDir).toContain("instance-b");
    });

    test("skips ports that probePort reports as in-use", async () => {
      // GIVEN a first local assistant already exists in the lockfile
      makeEntry({ assistantId: "existing" });

      // AND the default daemon ports are occupied
      const portsInUse = new Set([
        DEFAULT_DAEMON_PORT,
        DEFAULT_DAEMON_PORT + 1,
      ]);
      probePortMock.mockImplementation((port: number) =>
        Promise.resolve(portsInUse.has(port)),
      );

      // WHEN we allocate resources for a new instance
      const res = await allocateLocalPlacement("probe-test");

      // THEN the daemon port skips all occupied ports
      if (res.daemonPort === undefined)
        throw new Error("expected an allocated daemon port");
      expect(res.daemonPort).toBeGreaterThan(DEFAULT_DAEMON_PORT + 1);
      expect(portsInUse.has(res.daemonPort)).toBe(false);
    });
  });

  describe("resolveTargetAssistant() priority chain", () => {
    test("explicit name returns that entry", () => {
      makeEntry({ assistantId: "alpha" });
      makeEntry({ assistantId: "beta" });
      const result = resolveTargetAssistant("beta");
      expect(result.assistantId).toBe("beta");
    });

    test("active assistant set returns the active entry", () => {
      makeEntry({ assistantId: "alpha" });
      makeEntry({ assistantId: "beta" });
      setActiveAssistant("alpha");
      const result = resolveTargetAssistant();
      expect(result.assistantId).toBe("alpha");
    });

    test("sole local assistant returns it", () => {
      makeEntry({ assistantId: "only-one" });
      const result = resolveTargetAssistant();
      expect(result.assistantId).toBe("only-one");
    });

    test("multiple local assistants and no active throws with guidance", () => {
      makeEntry({ assistantId: "x" });
      makeEntry({ assistantId: "y" });
      // resolveTargetAssistant calls process.exit(1) on ambiguity
      const mockExit = mock(() => {
        throw new Error("process.exit called");
      });
      const origExit = process.exit;
      process.exit = mockExit as unknown as typeof process.exit;
      try {
        expect(() => resolveTargetAssistant()).toThrow("process.exit called");
        expect(mockExit).toHaveBeenCalledWith(1);
      } finally {
        process.exit = origExit;
      }
    });

    test("no local assistants throws", () => {
      writeLockfile({ assistants: [] });
      const mockExit = mock(() => {
        throw new Error("process.exit called");
      });
      const origExit = process.exit;
      process.exit = mockExit as unknown as typeof process.exit;
      try {
        expect(() => resolveTargetAssistant()).toThrow("process.exit called");
        expect(mockExit).toHaveBeenCalledWith(1);
      } finally {
        process.exit = origExit;
      }
    });
  });

  describe("setActiveAssistant() / getActiveAssistant() round-trip", () => {
    test("set active, read it back", () => {
      makeEntry({ assistantId: "my-assistant" });
      setActiveAssistant("my-assistant");
      expect(getActiveAssistant()).toBe("my-assistant");
    });

    test("lockfile is updated on disk", () => {
      makeEntry({ assistantId: "disk-check" });
      setActiveAssistant("disk-check");
      const raw = readLockfileRaw();
      expect(raw.activeAssistant).toBe("disk-check");
    });
  });

  describe("removeLockfileAssistant() reassigns activeAssistant on removal", () => {
    test("set active to foo, remove foo, verify active is reassigned to bar", () => {
      makeEntry({ assistantId: "foo" });
      makeEntry({ assistantId: "bar" });
      setActiveAssistant("foo");
      removeLockfileAssistant("foo");
      expect(getActiveAssistant()).toBe("bar");
    });

    test("set active to foo, remove bar, verify active is still foo", () => {
      makeEntry({ assistantId: "foo" });
      makeEntry({ assistantId: "bar" });
      setActiveAssistant("foo");
      removeLockfileAssistant("bar");
      expect(getActiveAssistant()).toBe("foo");
    });
  });

  describe("remote non-regression", () => {
    test("resolveTargetAssistant works with remote entries", () => {
      makeEntry({
        assistantId: "my-remote",
        cloud: "custom",
        ipAddress: "10.0.0.4",
        port: 7831,
      });
      setActiveAssistant("my-remote");
      const result = resolveTargetAssistant();
      expect(result.assistantId).toBe("my-remote");
      expect(result.cloud).toBe("custom");
    });

    test("remote entries don't get resources applied", () => {
      makeEntry({
        assistantId: "cloud-box",
        cloud: "custom",
        ipAddress: "10.0.0.5",
        port: 7831,
      });
      const remoteEntry = readEntry("cloud-box");
      // Save and reload to verify resources are not injected
      saveLockfileAssistant(remoteEntry!);
      const result = resolveTargetAssistant("cloud-box");
      expect(
        result.cloud === "local" ? result.instanceDir : undefined,
      ).toBeUndefined();
    });
  });
});
