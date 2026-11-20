/**
 * The docker hatch integration suite.
 *
 * Hatches a real instance from three supplied image refs and exercises it
 * solely through `cadet-test` cli commands — the same public surface a user
 * drives — never through docker or implementation details. A bug that only
 * exists when the product runs (a fresh volume meeting a non-root process
 * at container start) has exactly one witness: the hatched instance.
 *
 * Image refs come from the environment (`CADET_ASSISTANT_IMAGE`,
 * `CADET_GATEWAY_IMAGE`, `CADET_CREDENTIAL_EXECUTOR_IMAGE`) — the release
 * pipeline passes digest refs of the images it just pushed; PR QA passes
 * locally built tags. Missing refs fail the suite: a release must never
 * pass because its detector was unconfigured.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const IMAGE_ENV_KEYS = [
  "CADET_ASSISTANT_IMAGE",
  "CADET_GATEWAY_IMAGE",
  "CADET_CREDENTIAL_EXECUTOR_IMAGE",
] as const;

const missingImageEnv = IMAGE_ENV_KEYS.filter(
  (key) => !process.env[key]?.trim(),
);
if (missingImageEnv.length > 0) {
  throw new Error(
    `docker hatch: image env missing (${missingImageEnv.join(", ")}) — ` +
      `the suite hatches the real images, so the runner must supply them`,
  );
}

/** Spawn cadet-test with this suite's sandboxed state root. */
function runCadetTest(args: string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  return spawnSync(
    process.execPath,
    [join(import.meta.dir, "cadet-test.ts"), ...args],
    {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, CADET_TEST_STATE_ROOT: stateRoot },
      timeout: 10 * 60_000,
    },
  );
}

function tail(output: string): string {
  return output.trim().split("\n").slice(-20).join("\n");
}

const stateRoot = mkdtempSync(join(tmpdir(), "cadet-qa-state-"));
const instance = `qa-${randomUUID().slice(0, 8)}`;

describe("docker hatch", () => {
  beforeAll(async () => {
    const r = runCadetTest(["hatch", "--remote", "docker", "--name", instance]);
    if (r.status !== 0) {
      throw new Error(
        `cadet-test hatch --remote docker failed\n${tail(r.stderr || r.stdout)}`,
      );
    }
  }, 15 * 60_000);

  afterAll(() => {
    if (stateRoot) {
      runCadetTest(["retire", instance, "--yes"]);
      rmSync(stateRoot, { recursive: true, force: true });
    }
  }, 3 * 60_000);

  test("assistant credentials list serves over the CES socket", () => {
    const r = runCadetTest([
      "exec",
      instance,
      "--timeout",
      "60",
      "--",
      "assistant",
      "credentials",
      "list",
      "--json",
    ]);
    if (r.status !== 0) {
      throw new Error(
        `cadet-test exec assistant credentials list failed (exit ${r.status})\n${tail(r.stderr || r.stdout)}`,
      );
    }

    // The one-shot CLI logs its INFO lines to stdout around the JSON
    // payload (CES discovery, handshake, teardown) — the payload is the
    // last brace-opening line.
    const jsonLine = r.stdout
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .pop();
    let parsed: { ok: boolean; credentials: unknown[] };
    try {
      parsed = JSON.parse(jsonLine ?? "") as {
        ok: boolean;
        credentials: unknown[];
      };
    } catch {
      throw new Error(
        `assistant credentials list --json did not print a JSON line\n` +
          `stdout tail: ${JSON.stringify(tail(r.stdout))}\n` +
          `stderr tail: ${JSON.stringify(tail(r.stderr))}`,
      );
    }
    expect(parsed.ok).toBe(true);
    expect(Array.isArray(parsed.credentials)).toBe(true);
  }, 120_000);
});
