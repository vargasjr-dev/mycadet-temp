import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { hatchAssistant } from "../operations/hatch";
import { readLockfile, saveLockfileAssistant } from "../lockfile";
import { findAssistantByName } from "../operations/lookup";

let home: string;
const ENV_KEYS = ["XDG_CONFIG_HOME", "XDG_DATA_HOME"] as const;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "hatch-op-"));
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key]);
    process.env[key] = path.join(home, key.toLowerCase());
  }
});

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

describe("hatchAssistant", () => {
  test("the router refuses the remotes it does not cover yet", async () => {
    for (const remote of ["docker", "baseten", "cloud", "custom"]) {
      const result = await hatchAssistant({ remote });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.status).toBe(400);
      expect(result.error).toContain(remote);
    }
    expect(findAssistantByName("docker")).toBeNull();
  });

  test("a duplicate local name answers 409 before anything starts", async () => {
    saveLockfileAssistant({
      assistantId: "hatch-op-dup",
      cloud: "local",
      instanceDir: path.join(home, "assistants", "hatch-op-dup"),
      port: 7830,
      daemonPort: 7821,
      cesPort: 7832,
    });
    const result = await hatchAssistant({ remote: "local", name: "hatch-op-dup" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(result.error).toContain("already hatched");
    expect(result.assistantId).toBe("hatch-op-dup");
    // The pre-existing entry is untouched — no second allocation ran.
    expect(readLockfile().assistants).toHaveLength(1);
  });
});
