import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The operation resolves its entry from the lockfile on disk, so the mount
// tests run against a sandboxed config/data home (the same fixture shape the
// Vite dev middleware's operator tests use).
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "operator-forward-"));
Object.assign(process.env, {
  CADET_ENVIRONMENT: "production",
  XDG_CONFIG_HOME: tempDir,
  XDG_DATA_HOME: path.join(tempDir, "data-home"),
});
const configDir = path.join(tempDir, "cadet");
const lockfilePath = path.join(configDir, "lockfile.json");

const writeLockfile = (assistants: unknown[]): void => {
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    lockfilePath,
    JSON.stringify({ assistants, activeAssistant: null }),
  );
};

import { forwardOperatorRequest } from "./operator-forward";

const request = (p: string, init: RequestInit = {}) =>
  new Request(`app://mycadet.ai${p}`, init);

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("forwardOperatorRequest — the electron host's operator mount", () => {
  beforeEach(() => {
    fs.rmSync(lockfilePath, { force: true });
  });

  test("an on-machine entry's retire DELETE runs the retire operation host-side", async () => {
    const instanceDir = path.join(tempDir, "instance-asst-1");
    fs.mkdirSync(instanceDir, { recursive: true });
    writeLockfile([
      { assistantId: "asst-1", cloud: "local", port: 7830, instanceDir },
    ]);

    const response = await forwardOperatorRequest(
      request("/v1/assistants/asst-1/retire/", { method: "DELETE" }),
    );

    // The operation ran against the sandboxed fixture: a bodyless 204 for
    // the bundle's null, and the entry removed from the lockfile.
    expect(response?.status).toBe(204);
    const lockfile = JSON.parse(fs.readFileSync(lockfilePath, "utf-8")) as {
      assistants: unknown[];
    };
    expect(lockfile.assistants).toEqual([]);
  });

  test("a non-operator request passes through untouched", async () => {
    expect(
      await forwardOperatorRequest(request("/v1/assistants/a/conversations")),
    ).toBeNull();
    expect(
      await forwardOperatorRequest(
        request("/v1/assistants/a/retire/", { method: "GET" }),
      ),
    ).toBeNull();
  });

  test("a platform-hosted entry's retire passes through to the planner", async () => {
    writeLockfile([{ assistantId: "asst-cloud", cloud: "cloud" }]);

    expect(
      await forwardOperatorRequest(
        request("/v1/assistants/asst-cloud/retire/", { method: "DELETE" }),
      ),
    ).toBeNull();
  });
});
