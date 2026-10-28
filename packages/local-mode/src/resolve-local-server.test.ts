import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolveLocalServerUrl } from "./lockfile-contract";

describe("resolveLocalServerUrl", () => {
  // The house env pattern: point the config-home resolution at a temp dir
  // per test (pinned to the local environment so the paths line up), and
  // restore the environment afterwards.
  let dir: string;
  let savedEnv: [string, string | undefined][];

  function writeLockfile(content: string): void {
    mkdirSync(join(dir, "cadet-local"), { recursive: true });
    writeFileSync(join(dir, "cadet-local", "lockfile.json"), content);
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cadet-local-server-"));
    savedEnv = ["CADET_ENVIRONMENT", "XDG_CONFIG_HOME"].map(
      (key) => [key, process.env[key]] as [string, string | undefined],
    );
    process.env.XDG_CONFIG_HOME = dir;
    process.env.CADET_ENVIRONMENT = "local";
  });

  afterEach(() => {
    for (const [key, value] of savedEnv) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test("the tunnel record's public URL wins when one is up", () => {
    writeLockfile(
      JSON.stringify({
        tunnel: {
          pid: 4321,
          provider: "cadet",
          startedAt: "2026-10-22T00:00:00Z",
          publicUrl: "https://tunnel.example.net",
        },
        app: { pid: 4322, port: 8000 },
        assistants: [],
        activeAssistant: null,
      }),
    );
    expect(resolveLocalServerUrl()).toBe("https://tunnel.example.net");
  });

  test("without a tunnel, the app server edge's loopback port is the base", () => {
    writeLockfile(
      JSON.stringify({
        app: { pid: 4322, port: 8000 },
        assistants: [],
        activeAssistant: null,
      }),
    );
    expect(resolveLocalServerUrl()).toBe("http://127.0.0.1:8000");
  });

  test("the tunnel's address only counts when it is a usable base URL", () => {
    writeLockfile(
      JSON.stringify({
        tunnel: { publicUrl: "not a url" },
        app: { pid: 4322, port: 8000 },
        assistants: [],
        activeAssistant: null,
      }),
    );
    expect(resolveLocalServerUrl()).toBe("http://127.0.0.1:8000");
  });

  test("no records resolve to undefined so the caller can fall back", () => {
    writeLockfile(
      JSON.stringify({ assistants: [], activeAssistant: null }),
    );
    expect(resolveLocalServerUrl()).toBeUndefined();
  });
});
