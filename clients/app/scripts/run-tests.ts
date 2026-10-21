import { runIsolatedTests } from "@mycadet/shared/scripts/run-isolated-tests";

await runIsolatedTests({
  extraFiles: ["vite-plugin-local-mode.test.ts", "vite/cloud-proxy.test.ts"],
});
