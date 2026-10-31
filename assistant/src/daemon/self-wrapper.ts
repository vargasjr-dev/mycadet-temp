/**
 * The developer-facing `assistant` wrapper, written by the daemon itself.
 *
 * A compiled `assistant` binary ships beside the daemon binary in the app
 * bundle, and invoking it from a terminal needs the instance-specific env
 * vars pre-injected. The daemon knows all of them — it runs with the final
 * environment and derives the instance layout from its own workspace — so
 * the wrapper write happens here at boot rather than host-side in the CLI:
 * the writer is the process the wrapper re-creates, and every boot refreshes
 * it (idempotent overwrite).
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { basename, dirname, join } from "node:path";

/** Whether `execPath` is a bun runtime rather than a compiled product binary. */
function isBunRuntime(execPath: string): boolean {
  const base = basename(execPath);
  return base === "bun" || base === "bunx" || base.startsWith("bun-");
}

export function writeSelfWrapper(): void {
  if (platform() === "win32") {
    return;
  }
  // A source/dev run has no compiled binary for the wrapper to exec.
  if (isBunRuntime(process.execPath)) {
    return;
  }
  const workspaceDir = process.env.CADET_WORKSPACE_DIR?.trim();
  if (!workspaceDir) {
    return;
  }
  // The compiled `assistant` ships beside this daemon binary in the bundle.
  const assistantBinary = join(dirname(process.execPath), "assistant");
  if (!existsSync(assistantBinary)) {
    return;
  }
  // The instance-level security dirs are the workspace's siblings; an env
  // override wins where a topology (the docker container) set one.
  const instanceDir = dirname(workspaceDir);
  const lines = [
    "#!/bin/sh",
    `export CADET_WORKSPACE_DIR="${workspaceDir}"`,
    `export GATEWAY_SECURITY_DIR="${process.env.GATEWAY_SECURITY_DIR ?? join(instanceDir, "gateway-security")}"`,
    `export CREDENTIAL_SECURITY_DIR="${process.env.CREDENTIAL_SECURITY_DIR ?? join(instanceDir, "ces-security")}"`,
    `export CES_DATA_DIR="${process.env.CES_DATA_DIR ?? join(instanceDir, "ces-data")}"`,
    `exec "${assistantBinary}" "$@"`,
    "",
  ];
  mkdirSync(join(workspaceDir, "bin"), { recursive: true });
  writeFileSync(join(workspaceDir, "bin", "assistant"), lines.join("\n"), {
    mode: 0o755,
  });
}
