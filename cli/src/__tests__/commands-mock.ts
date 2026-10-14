import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import * as childProcess from "node:child_process";
import { PassThrough } from "node:stream";
import { spyOn } from "bun:test";

export interface CommandRequest {
  command: string;
  args: string[];
  input: Buffer;
}
export interface CommandResponse {
  stdout?: string;
  stderr?: string;
  code?: number;
}

/** requests-mock pattern at the subprocess boundary: explicit registrations, history and no fallthrough to real commands. */
export function mockCommands() {
  const calls: CommandRequest[] = [];
  const handlers: Array<{
    command: string;
    match: (args: string[]) => boolean;
    respond: (
      request: CommandRequest,
    ) => CommandResponse | Promise<CommandResponse>;
  }> = [];
  const implementation = (command: string, argsOrOptions: unknown = []) => {
    const args: string[] = Array.isArray(argsOrOptions) ? argsOrOptions : [];
    const request: CommandRequest = {
      command,
      args: [...args],
      input: Buffer.alloc(0),
    };
    calls.push(request);
    const handler = [...handlers]
      .reverse()
      .find((entry) => entry.command === command && entry.match(request.args));
    if (!handler) throw new Error(`Unregistered command: ${command}`);
    const stdin = new PassThrough(),
      stdout = new PassThrough(),
      stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr,
      stdio: [stdin, stdout, stderr],
      kill: () => true,
    });
    const chunks: Buffer[] = [];
    stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    const respond = async () => {
      request.input = Buffer.concat(chunks);
      try {
        const result = await handler.respond(request);
        stdout.end(result.stdout ?? "");
        stderr.end(result.stderr ?? "");
        child.emit("close", result.code ?? 0);
      } catch (error) {
        child.emit("error", error);
        child.emit("close", 1);
      }
    };
    if (request.args.includes("-i"))
      stdin.once("finish", () => {
        void respond();
      });
    else
      queueMicrotask(() => {
        void respond();
      });
    return child as unknown as ChildProcessWithoutNullStreams;
  };
  const spawn = spyOn(childProcess, "spawn").mockImplementation(
    implementation as typeof childProcess.spawn,
  );
  return {
    calls,
    on(
      command: string,
      args: string[] | ((args: string[]) => boolean),
      response:
        | CommandResponse
        | ((
            request: CommandRequest,
          ) => CommandResponse | Promise<CommandResponse>),
    ) {
      handlers.push({
        command,
        match:
          typeof args === "function"
            ? args
            : (actual) => JSON.stringify(actual) === JSON.stringify(args),
        respond: typeof response === "function" ? response : () => response,
      });
    },
    restore() {
      spawn.mockRestore();
    },
  };
}
