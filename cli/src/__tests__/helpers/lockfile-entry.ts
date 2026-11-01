import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  LockfileAssistantSchema,
  type ContainerInfo,
  type LocalAssistant,
  type LockfileAssistant,
  type Remote,
} from "@mycadet/local-mode/contract";

import { resolveLockfilePath } from "@mycadet/local-mode";

/**
 * A flat, explicit-optional override set — deliberately NOT a
 * `Partial<LockfileAssistant>`: on a discriminated union that partial
 * collapses to the fields every branch shares, so per-topology overrides
 * (a baseten `sandboxUrl`, a docker `containerInfo`) don't type. The flat
 * shape plus the schema parse below keeps the fixture honest instead.
 */
export type EntryOverrides = {
  assistantId?: string;
  name?: string;
  cloud?: Remote;
  instanceDir?: string;
  watcherPid?: number;
  containerInfo?: Partial<ContainerInfo>;
  mgmtSocket?: string;
  bearerToken?: string;
  cloudAssistantId?: string;
  cloudBaseUrl?: string;
  cloudOrganizationId?: string;
  ipAddress?: string;
  port?: number;
  daemonPort?: number;
  cesPort?: number;
  runtimeVersion?: string;
  runtimeInstallDir?: string;
  sandboxUrl?: string;
  hatchedAt?: string;
  onboardedAt?: string;
};

/** The placement a fresh local fixture carries. */
export const BASE_PLACEMENT = {
  instanceDir: "/tmp/cadet-test-instance",
  daemonPort: 7801,
  port: 7831,
  cesPort: 7790,
};

function readLockfileRaw(): Record<string, unknown> {
  try {
    const raw = JSON.parse(readFileSync(resolveLockfilePath(), "utf-8")) as {
      assistants?: unknown[];
    };
    return raw ?? {};
  } catch {
    return {};
  }
}

function readAssistants(): unknown[] {
  const raw = readLockfileRaw().assistants;
  return Array.isArray(raw) ? raw : [];
}

/**
 * The canonical entry WITHOUT the disk write — for tests that exercise the
 * save side (`saveLockfileAssistant`) directly and need a fresh object.
 */
export function makeEntryObject(
  overrides: EntryOverrides = {},
): LockfileAssistant {
  return LockfileAssistantSchema.parse({
    assistantId: "assistant-1",
    cloud: "local",
    ...BASE_PLACEMENT,
    ...overrides,
  });
}

/**
 * The canonical lockfile-entry fixture — one `makeEntry` for every suite.
 * Writes the entry straight into the lockfile the suite has pointed the CLI
 * at (via `XDG_CONFIG_HOME`) and returns void: suites that need the object
 * read it back with `readEntry`. The entry parses through
 * `LockfileAssistantSchema` so the shape is always the contract's.
 */
export function makeEntry(overrides: EntryOverrides = {}): void {
  const entry = LockfileAssistantSchema.parse({
    assistantId: "assistant-1",
    cloud: "local",
    ...BASE_PLACEMENT,
    ...overrides,
  });
  const assistants = readAssistants();
  const index = assistants.findIndex(
    (a) =>
      typeof a === "object" &&
      a !== null &&
      "assistantId" in a &&
      a.assistantId === entry.assistantId,
  );
  if (index >= 0) {
    assistants[index] = entry;
  } else {
    assistants.push(entry);
  }
  const path = resolveLockfilePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({ ...readLockfileRaw(), assistants }, null, 2),
  );
}

/** The entry `makeEntry` wrote, parsed back through the contract. */
export function readEntry(
  assistantId = "assistant-1",
): LockfileAssistant | undefined {
  const assistants = readAssistants();
  const found = assistants.find(
    (a) =>
      typeof a === "object" &&
      a !== null &&
      "assistantId" in a &&
      a.assistantId === assistantId,
  );
  return found === undefined ? undefined : LockfileAssistantSchema.parse(found);
}

/**
 * `readEntry` for the canonical local fixture — narrows the union so the
 * suites can assert on the runtime fields directly. Throws when the entry
 * on disk is not a local assistant.
 */
export function readLocalEntry(assistantId = "assistant-1"): LocalAssistant {
  const entry = readEntry(assistantId);
  if (!entry || entry.cloud !== "local") {
    throw new Error(
      `expected a local test entry '${assistantId}', found ${entry?.cloud ?? "nothing"}`,
    );
  }
  return entry;
}
