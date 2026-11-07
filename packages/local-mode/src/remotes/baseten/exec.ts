/**
 * Exec into a running Baseten sandbox. The installed `baseten` CLI is
 * preferred — it streams output live, forwards stdin (`--stdin`), owns its
 * own auth, and passes the command's exit code through. Without a CLI the
 * same operation rides the sandbox's execution API (`POST /process`): one
 * streaming NDJSON response whose events carry the output and whose final
 * `result` event carries the exit code — authenticated with the sandbox
 * access token saved beside the lockfile at hatch time.
 */

import { spawn } from "node:child_process";
import { readBasetenSandboxToken } from "../../guardian-token.js";
import { resolveBasetenCli } from "./baseten-cli.js";
import { basetenTeamId } from "./api.js";

/**
 * Quote one argv element for the sandbox's shell — `sh`-safe single quotes,
 * left off entirely when the argument is already plain (the common case:
 * `ls -la /tmp` stays readable in the sandbox's own process list).
 */
function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

/**
 * The exec request's `command` is a single shell line. Joining the argv with
 * per-argument quoting matches the CLI's multi-argument semantics: each
 * element stays one argument, while pipes, variables, and redirects the
 * CALLER passed as one argument are still interpreted by the sandbox's
 * shell.
 */
export function execCommandLine(command: string[]): string {
  return command.map(shellQuote).join(" ");
}

/** The CLI arm's argv — `--team` rides when the env selects one (#718's
 * translation), `--stdin` forwards the caller's stdin for interactive execs. */
export function basetenExecArgs(
  name: string,
  command: string[],
  options: { team?: string; stdin?: boolean; timeoutSeconds?: number } = {},
): string[] {
  return [
    "sandbox",
    "exec",
    "--name",
    name,
    ...(options.team ? ["--team", options.team] : []),
    ...(options.stdin ? ["--stdin"] : []),
    ...(options.timeoutSeconds !== undefined
      ? ["--timeout", `${options.timeoutSeconds}s`]
      : []),
    "--",
    ...command,
  ];
}

/** One NDJSON line's event from the execution API's stream. */
export interface BasetenExecEvent {
  type: string;
  data?: string;
}

/**
 * Consume one event line: `stdout`/`stderr` events stream their data to the
 * sink as it arrives; the final `result` event's data is a serialized
 * ProcessResponse whose `exitCode` answers. Returns the event's exit code,
 * or null when the stream continues.
 */
export function consumeBasetenExecEvent(
  event: BasetenExecEvent,
  onOutput: (chunk: string, stream: "stdout" | "stderr") => void,
): number | null {
  if (event.type === "stdout" || event.type === "stderr") {
    if (event.data) onOutput(event.data, event.type);
    return null;
  }
  if (event.type === "result") {
    if (!event.data) return 1;
    const parsed = JSON.parse(event.data) as { exitCode?: number | null };
    return parsed.exitCode ?? 1;
  }
  return null;
}

/** The services a baseten sandbox runs — a local hatch's stack in one VM. */
export type BasetenExecService =
  | "assistant"
  | "gateway"
  | "credential-executor";

/**
 * The command the SANDBOX actually runs: the caller's argv wrapped in the
 * sandbox's own `cadet exec`, so the invocation rides the cadet runtime
 * running in there (a local hatch the entrypoint woke) — the service picks
 * the working directory (workspace vs the gateway's security dir vs CES
 * data) the same way it does on the user's machine.
 */
export function cadetExecCommand(
  command: string[],
  service?: BasetenExecService,
): string[] {
  return [
    "cadet",
    "exec",
    ...(service && service !== "assistant" ? ["--service", service] : []),
    "--",
    ...command,
  ];
}

export type BasetenExecOptions = {
  /** The lockfile entry's id — the token file is keyed by it. */
  assistantId: string;
  /** The sandbox's server URL (the execution API's base). */
  sandboxUrl: string;
  /** The sandbox's name (recorded in the lockfile at hatch). */
  name: string;
  /** The command to run, as argv (wrapped in the sandbox's cadet exec). */
  command: string[];
  /** Which service's working directory the command runs in. */
  service?: BasetenExecService;
  /** Forward stdin (the CLI arm's `--stdin`). */
  interactive?: boolean;
  /** Seconds before the sandbox kills the process; 0 = never. Omitted when
   * the caller gave no explicit timeout. */
  timeoutSeconds?: number;
  /** The HTTP arm's streaming sink (defaults to process.stdout/stderr). */
  onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
};

export async function execBasetenSandbox(
  options: BasetenExecOptions,
): Promise<{ code: number }> {
  const innerCommand = cadetExecCommand(options.command, options.service);
  const team = basetenTeamId();
  if (await resolveBasetenCli()) {
    const code = await new Promise<number>((resolve, reject) => {
      const child = spawn(
        "baseten",
        basetenExecArgs(options.name, innerCommand, {
          team,
          stdin: options.interactive,
          timeoutSeconds: options.timeoutSeconds,
        }),
        { stdio: "inherit", windowsHide: true },
      );
      child.on("error", reject);
      child.on("exit", (code) => resolve(code ?? 1));
    });
    return { code };
  }

  if (options.interactive) {
    throw new Error(
      "Interactive exec over HTTP needs stdin piping, which the execution API's stream does not carry — install the `baseten` CLI for interactive exec.",
    );
  }

  const token = readBasetenSandboxToken(options.assistantId);
  if (!token.ok) {
    throw new Error(
      `${token.error} (exec over HTTP authenticates with the sandbox token, not BASETEN_API_KEY)`,
    );
  }

  const onOutput =
    options.onOutput ??
    ((chunk: string, stream: "stdout" | "stderr") => {
      (stream === "stdout" ? process.stdout : process.stderr).write(chunk);
    });

  const response = await fetch(
    `${options.sandboxUrl.replace(/\/+$/, "")}/process`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        command: execCommandLine(innerCommand),
        ...(options.timeoutSeconds !== undefined
          ? { timeout: options.timeoutSeconds }
          : {}),
      }),
    },
  );
  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `The sandbox's execution API refused the exec (HTTP ${response.status})${detail ? `: ${detail.slice(0, 400)}` : ""}`,
    );
  }

  // The response is NDJSON — one event per line, terminated by `result`.
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let code: number | null = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const event = JSON.parse(line) as BasetenExecEvent;
      const result = consumeBasetenExecEvent(event, onOutput);
      if (result !== null) code = result;
    }
  }
  return { code: code ?? 1 };
}
