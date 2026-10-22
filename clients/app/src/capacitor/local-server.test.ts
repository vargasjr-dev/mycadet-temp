import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { resolveLocalServerUrl } from "./local-server";

describe("resolveLocalServerUrl", () => {
  const cleanup: string[] = [];

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "cadet-local-server-"));
    cleanup.push(dir);
    return dir;
  }

  function lockfileWith(assistants: unknown[]): string {
    const dir = tempDir();
    writeFileSync(
      join(dir, "lockfile.json"),
      JSON.stringify({ assistants, activeAssistant: null }),
    );
    return dir;
  }

  afterEach(() => {
    for (const dir of cleanup.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the tunnel URL wins when the workspace records one", () => {
    const workspace = tempDir();
    writeFileSync(
      join(workspace, "config.json"),
      JSON.stringify({
        ingress: { publicBaseUrl: "https://tunnel.example.net", enabled: true },
      }),
    );
    expect(resolveLocalServerUrl({ CADET_WORKSPACE_DIR: workspace })).toBe(
      "https://tunnel.example.net",
    );
  });

  test("without a tunnel, the loopback app-server port is the base", () => {
    const lockfile = lockfileWith([
      {
        assistantId: "a1",
        cloud: "local",
        resources: { gatewayPort: 20100, daemonPort: 20000 },
      },
    ]);
    expect(resolveLocalServerUrl({ CADET_LOCKFILE_DIR: lockfile })).toBe(
      "http://127.0.0.1:20000",
    );
  });

  test("paired and remote entries never steer the local stamp", () => {
    const lockfile = lockfileWith([
      {
        assistantId: "a1",
        cloud: "local",
        paired: true,
        runtimeUrl: "https://paired.example.net",
      },
      {
        assistantId: "a2",
        cloud: "custom",
        runtimeUrl: "https://x.example",
        resources: { gatewayPort: 1, daemonPort: 2 },
      },
    ]);
    expect(resolveLocalServerUrl({ CADET_LOCKFILE_DIR: lockfile })).toBeUndefined();
  });

  test("an unusable tunnel record falls through to the loopback port", () => {
    const workspace = tempDir();
    writeFileSync(
      join(workspace, "config.json"),
      JSON.stringify({ ingress: { publicBaseUrl: "not a url" } }),
    );
    const lockfile = lockfileWith([
      {
        assistantId: "a1",
        cloud: "local",
        resources: { gatewayPort: 20100, daemonPort: 20000 },
      },
    ]);
    expect(
      resolveLocalServerUrl({
        CADET_WORKSPACE_DIR: workspace,
        CADET_LOCKFILE_DIR: lockfile,
      }),
    ).toBe("http://127.0.0.1:20000");
  });

  test("no records, a corrupt workspace config, or an empty lockfile resolve nothing", () => {
    expect(
      resolveLocalServerUrl({ CADET_WORKSPACE_DIR: tempDir() }),
    ).toBeUndefined();
    const corrupt = tempDir();
    writeFileSync(join(corrupt, "config.json"), "{ not json");
    expect(
      resolveLocalServerUrl({ CADET_WORKSPACE_DIR: corrupt }),
    ).toBeUndefined();
    expect(
      resolveLocalServerUrl({ CADET_LOCKFILE_DIR: lockfileWith([]) }),
    ).toBeUndefined();
  });
});
