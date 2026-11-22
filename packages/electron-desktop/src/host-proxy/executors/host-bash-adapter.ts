/**
 * host_bash adapter: runs the wire-contract command strings through the
 * host's shell — bash on Linux and macOS, Windows PowerShell on Windows —
 * via the shared host shell executor.
 *
 * The host_bash contract carries an opaque command string; on Windows it is
 * executed by powershell.exe with no fallback to Bash or another shell. A
 * missing PowerShell binary surfaces as an error result, never a different
 * interpreter.
 *
 * The spawn is built here, as a plain `child_process` spawn would: the
 * environments package's shell builder speaks for the sandboxed runtimes
 * (its Linux arm pre-writes the shell's OOM-kill priority for the
 * container's OOM hierarchy — a concern the desktop host does not share),
 * and the desktop's own shell needs nothing but the file/args pair.
 */

import type { HostProxyExecutor } from "../router";
import {
  createHostShellExecutor,
  type HostShellSpec,
} from "./host-shell-executor";

/**
 * -NoProfile and -NonInteractive keep execution deterministic and prompt
 * free; -EncodedCommand carries the command as base64 UTF-16LE so quoting
 * and Unicode survive Windows command-line re-parsing untouched. The
 * preamble forces UTF-8 output encoding, and the suffix folds a failed
 * builtin (a set `$?` with no native exit code) into a real non-zero exit,
 * so the executor's exit-code reporting works for commands that never
 * launched a process.
 */
const WINDOWS_UTF8_PREAMBLE =
  "try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}; " +
  "$OutputEncoding = [System.Text.Encoding]::UTF8; " +
  "$global:LASTEXITCODE = 0;";

const WINDOWS_EXIT_STATUS_SUFFIX = `
$__cadetCommandSucceeded = $?
$__cadetNativeExitCode = $LASTEXITCODE
if (-not $__cadetCommandSucceeded) {
  if ($__cadetNativeExitCode -ne 0) { exit $__cadetNativeExitCode }
  exit 1
}
exit 0`;

const createSpec = (executable?: string): HostShellSpec => ({
  buildSpawn: (command) => {
    if (process.platform === "win32") {
      return {
        file: executable ?? "powershell.exe",
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-EncodedCommand",
          Buffer.from(
            `${WINDOWS_UTF8_PREAMBLE}\n${command}${WINDOWS_EXIT_STATUS_SUFFIX}`,
            "utf16le",
          ).toString("base64"),
        ],
      };
    }
    return { file: "bash", args: ["-c", "--", command] };
  },
});

export const createHostBashExecutor = (
  executable?: string,
): HostProxyExecutor => createHostShellExecutor(createSpec(executable));

export const hostBashExecutor = createHostBashExecutor();
