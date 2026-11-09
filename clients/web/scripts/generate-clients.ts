/**
 * Generates the web's API clients — the one script `openapi-ts` runs.
 *
 * Pipeline:
 *   1. Ensure the source specs are current: each generator's `--check` mode
 *      byte-compares against the spec on disk, so a rerun only writes when
 *      the route tables actually changed.
 *   2. Transform the specs for web consumption (proxied paths, assistant_id).
 *   3. Run hey-api's codegen — skipped entirely when a content hash of the
 *      three specs + the transform/config inputs matches the last run's
 *      stamp, so repeated installs don't re-churn `src/generated`.
 *
 * Inputs are hashed, not mtime-dated: the transforms rewrite their outputs
 * on every run, so wall-clock freshness is meaningless here.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(SCRIPT_DIR, "..");

const GENERATORS: Array<[string, string]> = [
  ["../../assistant", "generate:openapi"], // → assistant/openapi.yaml
  ["../../gateway", "generate:openapi"], // → gateway/openapi.json
];

const SPEC_INPUTS = [
  "openapi-schemas/operator.yaml",
  "openapi-schemas/daemon.json",
  "openapi-schemas/gateway.json",
];
const STAMP_PATH = resolve(WEB_ROOT, "openapi-schemas/.codegen-stamp.json");

function run(cmd: string[], opts: { cwd?: string } = {}): number {
  const res = spawnSync(cmd[0], cmd.slice(1), {
    cwd: opts.cwd ?? WEB_ROOT,
    stdio: "inherit",
  });
  return res.status ?? 1;
}

function hashInputs(): string {
  const hash = createHash("sha256");
  for (const rel of [
    ...SPEC_INPUTS,
    "scripts/transform-daemon-spec.ts",
    "scripts/transform-gateway-spec.ts",
    "openapi-ts.config.ts",
  ]) {
    hash.update(rel);
    hash.update(readFileSync(resolve(WEB_ROOT, rel)));
  }
  return hash.digest("hex");
}

function outputsExist(): boolean {
  return ["operator", "daemon", "gateway"].every((client) =>
    existsSync(resolve(WEB_ROOT, `src/generated/${client}/sdk.gen.ts`)),
  );
}

// 1. Source specs — regenerate only when stale (missing or content-drifted).
for (const [pkgDir, script] of GENERATORS) {
  const cwd = resolve(WEB_ROOT, pkgDir);
  const check = spawnSync("bun", ["run", script, "--", "--check"], {
    cwd,
    stdio: "pipe",
  });
  if (check.status !== 0) {
    if (run(["bun", "run", script], { cwd }) !== 0) {
      console.error(`[generate-clients] ${pkgDir} ${script} failed`);
      process.exit(1);
    }
  }
}

// 2. Web-facing transforms — top-level scripts, executed in-process in
// sequence (literal dynamic imports keep knip's dependency graph honest).
await import("./transform-daemon-spec.ts");
await import("./transform-gateway-spec.ts");

// 3. hey-api codegen — skip when the inputs match the last generation.
const hash = hashInputs();
if (outputsExist() && existsSync(STAMP_PATH)) {
  try {
    if (JSON.parse(readFileSync(STAMP_PATH, "utf-8")).hash === hash) {
      console.log(
        "[generate-clients] specs unchanged since last codegen — skipping",
      );
      process.exit(0);
    }
  } catch {
    // unreadable stamp → regenerate
  }
}

if (run(["bunx", "openapi-ts"]) !== 0) {
  console.error("[generate-clients] openapi-ts failed");
  process.exit(1);
}
writeFileSync(STAMP_PATH, `${JSON.stringify({ hash }, null, 2)}\n`);
console.log("[generate-clients] clients regenerated");
