import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolveLocalServerUrl } from "./local-server";

describe("resolveLocalServerUrl", () => {
  // The house env pattern: point the lockfile lookup at a temp dir per
  // test, restore the environment afterwards.
  let dir: string;

  function writeLockfile(content: string): void {
    writeFileSync(join(dir, "lockfile.json"), content);
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cadet-local-server-"));
    process.env.CADET_LOCKFILE_DIR = dir;
  });

  afterEach(() => {
    delete process.env.CADET_LOCKFILE_DIR;
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

  test("an unusable tunnel record falls through to the edge port", () => {
    writeLockfile(
      JSON.stringify({
        tunnel: { pid: 4321, provider: "cadet", startedAt: "x" },
        app: { pid: 4322, port: 8000 },
        assistants: [],
        activeAssistant: null,
      }),
    );
    expect(resolveLocalServerUrl()).toBe("http://127.0.0.1:8000");
  });

  test("neither record resolves nothing — the seed default takes over", () => {
    writeLockfile(
      JSON.stringify({ assistants: [], activeAssistant: null }),
    );
    expect(resolveLocalServerUrl()).toBeUndefined();
  });

  test("a missing or corrupt lockfile resolves nothing", () => {
    expect(resolveLocalServerUrl()).toBeUndefined();
    writeLockfile("{ not json");
    expect(resolveLocalServerUrl()).toBeUndefined();
  });

  test("assistant entries play no role in the resolution", () => {
    writeLockfile(
      JSON.stringify({
        assistants: [
          {
            assistantId: "a1",
            cloud: "local",
            runtimeUrl: "https://paired.example.net",
            resources: { gatewayPort: 20100, daemonPort: 20000 },
          },
        ],
        activeAssistant: "a1",
      }),
    );
    expect(resolveLocalServerUrl()).toBeUndefined();
  });
});
