/**
 * host_bash adapter: runs the wire-contract command strings through the
 * host's shell — bash on Linux, Windows PowerShell on Windows — via the
 * shared host shell executor.
 *
 * The host_bash contract carries an opaque command string; on Windows it is
 * executed by powershell.exe with no fallback to Bash or another shell. A
 * missing PowerShell binary surfaces as an error result, never a different
 * interpreter.
 */

import type { HostProxyExecutor } from "../router";
import {
  createHostShellExecutor,
  type HostShellSpec,
} from "./host-shell-executor";
import { buildShellInvocation } from "@mycadet/environments/shell";

/**
 * -NoProfile and -NonInteractive keep execution deterministic and prompt
 * free; -EncodedCommand carries the command as base64 UTF-16LE so quoting
 * and Unicode survive Windows command-line re-parsing untouched.
 */
const createSpec = (executable?: string): HostShellSpec => ({
  buildSpawn: (command) => {
    const invocation =
      process.platform === "win32"
        ? buildShellInvocation(command, "win32", executable ?? "powershell.exe")
        : buildShellInvocation(command, "linux");
    return { file: invocation.command, args: invocation.args };
  },
});

export const createHostBashExecutor = (
  executable?: string,
): HostProxyExecutor => createHostShellExecutor(createSpec(executable));

export const hostBashExecutor = createHostBashExecutor();
