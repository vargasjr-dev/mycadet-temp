import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { mock } from "bun:test";
import {
  type HatchDockerParams,
  type HatchDockerResult,
} from "../remotes/docker/hatch";
import {
  type HatchBasetenParams,
  type HatchBasetenResult,
} from "../remotes/baseten/hatch";
import { hatchAssistant } from "../operations/hatch";
import { existsSync } from "node:fs";
import { resolveLockfilePath } from "../config";
import { readLockfile, saveLockfileAssistant } from "../lockfile";
import { findAssistantByName } from "../operations/lookup";

const hatchDockerMock = mock<
  (params: HatchDockerParams) => Promise<HatchDockerResult>
>(async () => ({
  ok: true,
  entry: {
    assistantId: "leg-entry",
    cloud: "docker",
    port: 7830,
    daemonPort: 7821,
  },
  ready: true,
}));
mock.module("../remotes/docker/hatch", () => ({
  hatchDocker: hatchDockerMock,
}));

const basetenMock = mock<
  (params: HatchBasetenParams) => Promise<HatchBasetenResult>
>(async () => ({
  ok: true,
  entry: {
    assistantId: "baseten-entry",
    name: "sandbox-entry",
    cloud: "baseten",
    sandboxUrl: "https://sandbox.example.com",
    port: 7830,
  },
  ready: false,
}));
mock.module("../remotes/baseten/hatch", () => ({
  hatchBaseten: basetenMock,
}));

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
    for (const remote of ["custom"]) {
      const result = await hatchAssistant({ remote });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.status).toBe(400);
      expect(result.error).toContain(remote);
    }
    expect(findAssistantByName("custom")).toBeNull();
    // The refusal still leaves the lockfile behind: an empty registry the
    // next hatch (or any writer) builds on.
    expect(existsSync(resolveLockfilePath())).toBe(true);
    expect(readLockfile().assistants).toEqual([]);
  });

  test("the baseten arm routes to the leg and maps the entry back", async () => {
    const result = await hatchAssistant({
      remote: "baseten",
      name: "sandbox-entry",
      version: "1.2.3",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.assistant.assistantId).toBe("baseten-entry");
    // The sandbox wakes itself after the leg returns — the leg does not
    // confirm readiness, so the CLI's next-steps narration stays off.
    expect(result.ready).toBe(false);
    expect(basetenMock.mock.calls[0]?.[0]).toMatchObject({
      name: "sandbox-entry",
      version: "1.2.3",
    });
  });

  test("the docker arm routes to the leg and maps the entry back", async () => {
    const result = await hatchAssistant({
      remote: "docker",
      name: "leg-entry",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.assistant.assistantId).toBe("leg-entry");
    expect(result.ready).toBe(true);
    expect(hatchDockerMock.mock.calls[0]?.[0]).toMatchObject({
      name: "leg-entry",
      watch: undefined,
      version: undefined,
    });
  });

  test("the docker arm passes the leg's structured failure through untouched", async () => {
    hatchDockerMock.mockImplementationOnce(async () => ({
      ok: false as const,
      status: 503,
      error: "docker daemon down",
      assistantId: "leg-entry",
    }));

    const result = await hatchAssistant({ remote: "docker" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(503);
    expect(result.error).toBe("docker daemon down");
    expect(result.assistantId).toBe("leg-entry");
  });

  test("the cloud arm without a token answers 401 before any network call", async () => {
    const result = await hatchAssistant({ remote: "cloud" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(401);
    expect(result.error).toContain("cadet login");
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
    const result = await hatchAssistant({
      remote: "local",
      name: "hatch-op-dup",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(result.error).toContain("already hatched");
    expect(result.assistantId).toBe("hatch-op-dup");
    // The pre-existing entry is untouched — no second allocation ran.
    expect(readLockfile().assistants).toHaveLength(1);
  });
});
