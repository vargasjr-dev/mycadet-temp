import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";

import type { LocalAssistant } from "@mycadet/local-mode/contract";

import { healConflictedLocalPorts } from "../port-heal.js";
import {
  makeEntry,
  readEntry,
  readLocalEntry,
} from "../../__tests__/helpers/lockfile-entry.js";

// The fixture helper writes through the real lockfile path — isolate it.
const testDir = mkdtempSync(join(tmpdir(), "port-heal-test-"));
const prevConfigHome = process.env.XDG_CONFIG_HOME;
process.env.XDG_CONFIG_HOME = testDir;
afterAll(() => {
  if (prevConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevConfigHome;
});

/** Every port free, no listener pids, no sibling claims. */
const freeDeps = {
  isPortFree: async () => true,
  findListenerPid: () => undefined,
  otherReservedPorts: () => [],
};

describe("healConflictedLocalPorts", () => {
  test("a local entry with all ports free passes through untouched", async () => {
    makeEntry();
    const entry = readLocalEntry();
    expect(await healConflictedLocalPorts(entry, freeDeps)).toBe(null);
    expect(entry.resources?.daemonPort).toBe(7801);
    expect(entry.resources?.gatewayPort).toBe(7831);
    expect(entry.resources?.cesPort).toBe(7790);
  });

  test("a foreign-held daemon port is reallocated from the env base", async () => {
    makeEntry({ resources: { daemonPort: 9000 } });
    const entry = readLocalEntry();
    const result = await healConflictedLocalPorts(entry, {
      ...freeDeps,
      isPortFree: async (port) => port !== 9000 && port !== 7821,
    });
    // 9000 is held; the walk starts at the prod daemon base 7821 — but
    // 7821 is "occupied" too — and lands on the first genuinely free port.
    expect(result?.moves).toEqual([
      { field: "daemonPort", from: 9000, to: 7822 },
    ]);
    expect(entry.resources?.daemonPort).toBe(7822);
    expect(entry.resources?.gatewayPort).toBe(7831);
  });

  test("a port held by one of our own processes is never moved", async () => {
    makeEntry({ resources: { daemonPort: 9000 } });
    const entry = readLocalEntry();
    const result = await healConflictedLocalPorts(entry, {
      ...freeDeps,
      isPortFree: async (port) => port !== 9000,
      // an orphaned cadet daemon owns the recorded port
      findListenerPid: (port) => (port === 9000 ? 4242 : undefined),
      isOurProcess: (pid) => pid === 4242,
    });
    expect(result).toBe(null);
    expect(entry.resources?.daemonPort).toBe(9000);
  });

  test("a held port with no discoverable listener is treated as foreign", async () => {
    makeEntry({ resources: { daemonPort: 9000 } });
    const entry = readLocalEntry();
    const result = await healConflictedLocalPorts(entry, {
      ...freeDeps,
      isPortFree: async (port) => port !== 9000,
      findListenerPid: () => undefined, // lsof blind — move anyway
    });
    expect(result?.moves).toEqual([
      { field: "daemonPort", from: 9000, to: 7821 },
    ]);
  });

  test("a moved gateway port updates the recorded port — the url is no longer mirrored", async () => {
    makeEntry({ resources: { gatewayPort: 9001 } });
    const entry = readLocalEntry();
    const result = await healConflictedLocalPorts(entry, {
      ...freeDeps,
      isPortFree: async (port) => port !== 9001,
    });
    expect(result?.moves).toEqual([
      { field: "gatewayPort", from: 9001, to: 7830 },
    ]);
    expect(entry.resources?.gatewayPort).toBe(7830);
  });

  test("a healed move leaves no other address record to touch", async () => {
    makeEntry({
      resources: { gatewayPort: 9001 },
    });
    const entry = readLocalEntry();
    await healConflictedLocalPorts(entry, {
      ...freeDeps,
      isPortFree: async (port) => port !== 9001,
    });
    expect(entry.resources?.gatewayPort).toBe(7830);
  });

  test("the walk skips sibling claims, the entry's own ports, and fresh allocations", async () => {
    makeEntry({
      resources: { daemonPort: 9000, gatewayPort: 9001 },
    });
    const entry = readLocalEntry();
    const result = await healConflictedLocalPorts(entry, {
      ...freeDeps,
      // both recorded ports are held by a foreign process
      isPortFree: async (port) => port !== 9000 && port !== 9001,
      otherReservedPorts: () => [7821], // a sibling already claims the base
    });
    // daemon: 7821 claimed by a sibling → 7822. gateway: 7830 free but the
    // just-allocated daemon port and the abandoned 9000/9001 are excluded
    // where they matter — gateway walks from 7830 and lands there.
    expect(result?.moves).toEqual([
      { field: "daemonPort", from: 9000, to: 7822 },
      { field: "gatewayPort", from: 9001, to: 7830 },
    ]);
  });

  test("docker entries pass through untouched", async () => {
    makeEntry({
      cloud: "docker",
      resources: { daemonPort: 9000 },
    });
    const entry = readEntry();
    const result = await healConflictedLocalPorts(entry!, {
      ...freeDeps,
      isPortFree: async () => false,
    });
    expect(result).toBe(null);
    expect(
      entry?.cloud === "docker" ? entry.resources?.daemonPort : undefined,
    ).toBe(9000);
  });

  test("an entry without resources passes through untouched", async () => {
    makeEntry();
    const entry = readLocalEntry();
    // The contract always parses resources for a local entry; the guard
    // exists for the same defensive reason wake's own does.
    entry.resources = undefined;
    expect(await healConflictedLocalPorts(entry, freeDeps)).toBe(null);
  });
});
