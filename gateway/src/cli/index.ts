#!/usr/bin/env bun

/**
 * Operator CLI for gateway-owned state. Invoked as `gateway <command>`.
 *
 * This entry starts the CLI, not the gateway HTTP server. The server
 * remains `bun run src/index.ts`. The command tree lives in ./program.ts
 * (commander); one-shot commands print machine-readable JSON on stdout and
 * their callers parse it.
 */

import { initGatewayDb } from "../db/connection.js";
import { initSigningKey } from "../auth/token-service.js";

import { buildGatewayCliProgram } from "./program.js";

// Silence pino entirely (no pretty stdout, no log files) — the lazy proxy
// logger builds on the first log call, which happens inside the command
// bodies below, after this flag is set. Errors surface through
// console.error + exit codes instead.
process.env["GATEWAY_LOG_SILENT"] = "1";

const program = buildGatewayCliProgram();

// The database and signing key initialize only when an action actually
// runs — `gateway --help`, usage on a bare invocation, and parse errors
// all skip it, so help works on machines with no gateway state.
program.hook("preAction", async () => {
  await initGatewayDb({ migrate: false });
  initSigningKey();
});

await program.parseAsync(process.argv);
