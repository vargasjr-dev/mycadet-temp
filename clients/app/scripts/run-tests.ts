import { runIsolatedTests } from "@mycadet/shared/scripts/run-isolated-tests";

await runIsolatedTests({ extraFiles: ["vite/platform-proxy.test.ts"] });
