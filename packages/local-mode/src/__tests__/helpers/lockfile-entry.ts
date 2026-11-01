import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  LockfileAssistantSchema,
  type LocalAssistant,
  type LockfileAssistant,
  type Remote,
} from "../../lockfile-contract";

import { guardianBootstrapSecretPath, resolveLockfilePath } from "../../config";

/**
 * The canonical lockfile-entry fixture — one `makeEntry` for every suite.
 * Writes the entry straight into the lockfile the suite has pointed the
 * process at (via `XDG_CONFIG_HOME`) and returns void: suites that need the
 * object read it back with `readEntry`. The entry parses through
 * `LockfileAssistantSchema` so the shape is always the contract's.
 */
export type EntryOverrides = {
  assistantId?: string;
  name?: string;
  cloud?: Remote;
  instanceDir?: string;
  watcherPid?: number;
  containerInfo?: Record<string, unknown>;
  mgmtSocket?: string;
  cloudAssistantId?: string;
  cloudBaseUrl?: string;
  cloudOrganizationId?: string;
  ipAddress?: string;
  port?: number;
  daemonPort?: number;
  cesPort?: number;
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
