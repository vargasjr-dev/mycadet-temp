import { exec } from "../../exec";
import { extractHostFromEntry } from "../../operations/lookup";
import type { LockfileAssistant } from "../../lockfile-contract";

/**
 * The custom (ssh-reachable) topology's retire leg: best-effort remote
 * cleanup over ssh — sleep the assistant, kill the gateway, remove the
 * on-machine state. A partial remote failure is warned about and NOT fatal:
 * the custom machine may be unreachable, and the retire's local bookkeeping
 * must still complete.
 */
export async function retireCustom(entry: LockfileAssistant): Promise<void> {
  const host = extractHostFromEntry(entry);
  const sshHost = `root@${host}`;

  console.log(`\u{1F5D1}\ufe0f  Retiring custom instance on ${sshHost}...\n`);

  const remoteCmd = [
    "bunx cadet sleep 2>/dev/null || true",
    "pkill -f gateway 2>/dev/null || true",
    "rm -rf ~/.cadet",
  ].join(" && ");

  try {
    await exec("ssh", [
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "UserKnownHostsFile=/dev/null",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "LogLevel=ERROR",
      sshHost,
      remoteCmd,
    ]);
  } catch (error) {
    console.warn(
      `\u26a0\ufe0f  Remote cleanup may have partially failed: ${error instanceof Error ? error.message : error}`,
    );
  }

  console.log(`\u2705 Custom instance retired.`);
}
