import { describe, expect, test } from "bun:test";

import { runSanitizedBash } from "../sanitized-bash.js";

describe("runSanitizedBash", () => {
  test("runs a command and returns stdout", async () => {
    const result = await runSanitizedBash("echo hello", 5_000);
    expect(result.error).toBeUndefined();
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
  });

  test("strips CES_SERVICE_TOKEN from the child env — CES has no HTTP surface", async () => {
    process.env.CES_SERVICE_TOKEN = "vault-bearer";
    const result = await runSanitizedBash("printenv CES_SERVICE_TOKEN", 5_000);
    expect(result.error).toBeUndefined();
    // printenv exits non-zero when the variable is absent.
    expect(result.exitCode).toBe(1);
    expect(result.stdout.trim()).toBe("");
  });

  test("times out a hung command", async () => {
    const result = await runSanitizedBash("sleep 5", 200);
    expect(result.error).toBeUndefined();
    expect(result.timedOut).toBe(true);
  });

  test("rejects an empty command", async () => {
    const result = await runSanitizedBash("");
    expect(result.error).toBe("command is required");
    expect(result.exitCode).toBeNull();
  });
});
