import { runIsolatedTests } from "@mycadet/shared/scripts/run-isolated-tests";

await runIsolatedTests({
  extraFiles: [
    "../../packages/electron-desktop/src/capability-registry.test.ts",
    "../../packages/electron-desktop/src/device-id.test.ts",
    "../../packages/electron-desktop/src/native-auth.test.ts",
    "../../packages/electron-desktop/src/session-token-store.test.ts",
    "../../packages/electron-desktop/src/workos-pkce.test.ts",
  ],
});
