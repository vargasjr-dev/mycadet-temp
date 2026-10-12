import { Glob } from "bun";

import { runIsolatedTests } from "@mycadet/shared/scripts/run-isolated-tests";

// The account tree lives in clients/app (bundled into the desktop build via
// the tsconfig paths bridge), but its tests still run under web's harness —
// they import web shared modules via `@/`, so they cannot run standalone.
const appTests = [
  ...new Glob("../app/src/**/*.test.{ts,tsx}").scanSync({ cwd: process.cwd() }),
];

await runIsolatedTests({ extraFiles: appTests });
