import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The CLI entry is the gateway's SECOND entry into the module graph (the
 * HTTP server's main() is the first), and it owns the same startup contract:
 * initGatewayDb() before any command touches the DB. Regression: without the
 * init, every served command died on "Gateway DB not initialized" — burning
 * all three of the hatch's guardian-token lease retries (the lease's
 * local-presence proof is `gateway pairing mint`).
 */
describe("the gateway CLI entry", () => {
  test("initializes the DB before serving a command", () => {
    const workspace = mkdtempSync(join(tmpdir(), "gateway-cli-"));
    const result = Bun.spawnSync({
      // The device-bound mint is the hatch's guardian-lease door: it resolves
      // the cadet guardian through the contacts table, the DB the CLI entry
      // must initialize (the HTTP server's main() does the same). Regression:
      // without the init this exits 1 on "Gateway DB not initialized" and the
      // hatch burns all three of its lease retries on it.
      cmd: [
        process.execPath,
        "src/cli/index.ts",
        "pairing",
        "mint",
        "--device-id",
        "qa-device",
        "--platform",
        "cli",
      ],
      cwd: join(import.meta.dir, "..", ".."),
      env: {
        ...process.env,
        CADET_WORKSPACE_DIR: workspace,
        GATEWAY_SECURITY_DIR: join(workspace, "gateway-security"),
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60_000,
    });

    const output = `${result.stdout} ${result.stderr}`;
    expect(output).not.toMatch(/Gateway DB not initialized/);
    expect(result.exitCode).toBe(0);
  });
});
