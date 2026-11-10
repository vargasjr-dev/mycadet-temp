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
  const entryDir = join(import.meta.dir, "..", "..");

  function mintEnv(workspace: string) {
    return {
      ...process.env,
      CADET_WORKSPACE_DIR: workspace,
      GATEWAY_SECURITY_DIR: join(workspace, "gateway-security"),
    };
  }

  /** Stand in for the server's main(): open the DB in the workspace WITH
   * the schema push — the CLI entry deliberately passes `migrate: false`. */
  function migrateWorkspace(workspace: string): void {
    const migrate = Bun.spawnSync({
      cmd: [
        process.execPath,
        "-e",
        `const { initGatewayDb } = await import(process.cwd() + "/src/db/connection.ts"); await initGatewayDb();`,
      ],
      cwd: entryDir,
      env: mintEnv(workspace),
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60_000,
    });
    expect(migrate.exitCode).toBe(0);
  }

  test("initializes the DB before serving a command", () => {
    const workspace = mkdtempSync(join(tmpdir(), "gateway-cli-"));
    migrateWorkspace(workspace);

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
      cwd: entryDir,
      env: mintEnv(workspace),
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60_000,
    });

    const output = `${result.stdout} ${result.stderr}`;
    expect(output).not.toMatch(/Gateway DB not initialized/);
    expect(result.exitCode).toBe(0);
  });

  test("does not run migrations from the CLI entrypoint", () => {
    // A workspace the server never initialized has no schema — the mint
    // must fail on the missing table rather than push it. The schema push
    // stays with the server entry so an operator command can never take a
    // migration onto a possibly-live database.
    const workspace = mkdtempSync(join(tmpdir(), "gateway-cli-nomigrate-"));

    const result = Bun.spawnSync({
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
      cwd: entryDir,
      env: mintEnv(workspace),
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60_000,
    });

    const output = `${result.stdout} ${result.stderr}`;
    expect(output).toContain("no such table: contacts");
  });
});
