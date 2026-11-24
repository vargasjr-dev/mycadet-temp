#!/usr/bin/env bun
/**
 * CES CLI — lightweight credential CRUD for the encrypted key store.
 *
 * Operates directly on the encrypted key store (`keys.enc` + `store.key`)
 * without requiring the RPC server, HTTP routes, or a running assistant.
 *
 * Usage:
 *   ces list
 *   ces get <account>
 *   ces set <account> <value>
 *   ces delete <account>
 *
 * Account format: `credential/<service>/<field>` (e.g. `credential/cadet/platform_organization_id`)
 *
 * Environment variables:
 *   CREDENTIAL_SECURITY_DIR — directory containing `keys.enc` + `store.key`
 *                             (falls back to `./ces-security`)
 */

import { Command } from "commander";
import packageJson from "../package.json" with { type: "json" };

import { createLocalSecureKeyBackend } from "./materializers/local-secure-key-backend.js";
import { getSecurityDir } from "./paths.js";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

let backend: Awaited<ReturnType<typeof createLocalSecureKeyBackend>> | null =
  null;

/** One backend per process, built lazily so help never touches the store. */
function keyBackend() {
  backend ??= createLocalSecureKeyBackend(getSecurityDir());
  return backend;
}

const program = new Command();
program
  .name("ces")
  .version(packageJson.version)
  .description("CES CLI — credential CRUD for the encrypted key store");

program
  .command("list")
  .description("List all credential accounts")
  .action(async () => {
    const accounts = await keyBackend().list();
    if (accounts.length === 0) {
      console.log("(no credentials stored)");
    } else {
      for (const account of accounts.sort()) {
        console.log(account);
      }
    }
  });

program
  .command("get <account>")
  .description("Get a credential value")
  .action(async (account: string) => {
    const value = await keyBackend().get(account);
    if (value === undefined) {
      console.error(`Not found: ${account}`);
      process.exit(1);
    }
    // Write raw value to stdout (no trailing newline for piping)
    process.stdout.write(value);
  });

program
  .command("set <account> <value>")
  .description("Set a credential value")
  .action(async (account: string, value: string) => {
    const ok = await keyBackend().set(account, value);
    if (ok) {
      console.log(`Set: ${account}`);
    } else {
      console.error(`Failed to set: ${account}`);
      process.exit(1);
    }
  });

program
  .command("delete <account>")
  .description("Delete a credential")
  .action(async (account: string) => {
    const result = await keyBackend().delete(account);
    if (result === "deleted") {
      console.log(`Deleted: ${account}`);
    } else {
      console.error(`Not found: ${account}`);
      process.exit(1);
    }
  });

program.addHelpText(
  "after",
  `
Account format:
  credential/<service>/<field>
  Example: credential/cadet/platform_organization_id

Environment:
  CREDENTIAL_SECURITY_DIR    Directory containing keys.enc + store.key
                             (falls back to ./ces-security)`,
);

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(`Fatal: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
