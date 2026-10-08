import { runIsolatedTests } from "../../../scripts/run-isolated-tests";

await runIsolatedTests({
  cwd: import.meta.dir + "/..",
  patterns: ["src/**/*.test.{ts,tsx}"],
  // PR test runs scope to the files a PR actually touched (diff vs
  // TEST_DIFF_BASE under the package dir), matching pr-assistant/pr-gateway.
  diffPath: "packages/ces-client",
});
