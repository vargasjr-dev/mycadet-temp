/**
 * The assistant's own shell-spawn builder for assistant-owned shell children
 * (sandbox bash, sanitized CLI bash, skill runners, inline commands,
 * scheduled scripts, ACP agents).
 *
 * The contract an opaque command string rides on: bash on POSIX, Windows
 * PowerShell elsewhere. On Linux the shell raises its own `oom_score_adj`
 * first — this code runs in the container, where the OOM hierarchy decides
 * who dies and the assistant must not be the victim of a runaway tool.
 */

export interface ShellInvocation {
  command: string;
  args: string[];
}

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

/**
 * `oom_score_adj` for assistant-owned tool processes. Any positive value
 * outranks a 0-scored process; 1000 makes a tool the kernel's first choice
 * whenever the container runs out of memory, so the assistant itself is never
 * the victim of a runaway command.
 */
export const CHILD_OOM_SCORE_ADJ = 1000;

/**
 * Prefix for a Bash `-c` script that raises the shell's own OOM-kill priority
 * before the command runs. Every process the command forks inherits it. Bash
 * performs a builtin's redirection itself, so `/proc/self` is the shell.
 * Redirections apply left to right, so stderr goes to /dev/null before the
 * procfs open can fail and complain about it.
 */
const LINUX_OOM_SCORE_ADJ_PREFIX = `echo ${CHILD_OOM_SCORE_ADJ} 2>/dev/null >/proc/self/oom_score_adj; `;

export function buildShellInvocation(
  command: string,
  hostPlatform: NodeJS.Platform = process.platform,
  windowsExecutable = "powershell.exe",
): ShellInvocation {
  if (hostPlatform === "win32") {
    return {
      command: windowsExecutable,
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
  const script =
    hostPlatform === "linux"
      ? `${LINUX_OOM_SCORE_ADJ_PREFIX}${command}`
      : command;
  return { command: "bash", args: ["-c", "--", script] };
}
