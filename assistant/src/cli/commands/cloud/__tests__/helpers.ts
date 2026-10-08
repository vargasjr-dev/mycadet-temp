import { mock } from "bun:test";

import { Command } from "commander";

/** Mutable per-file mock state returned by {@link setupCloudIpcMock}. */
export interface CloudIpcMockState {
  /** Every (method, params) pair passed to the mocked cliIpcCall. */
  calls: Array<[string, Record<string, unknown>]>;
  /** The value the mocked cliIpcCall resolves with. */
  response: unknown;
}

/**
 * Install the shared IPC client mock for a cloud command test file.
 *
 * bun's mock.module is global per test file, so each file must call this
 * once at module top level (before importing ../index.js) and drive the
 * mock through the returned state object. The mocked exitFromIpcResult
 * throws so tests can assert the error path without exiting the process.
 */
export function setupCloudIpcMock(): CloudIpcMockState {
  const state: CloudIpcMockState = { calls: [], response: undefined };
  mock.module("../../../../ipc/cli-client.js", () => ({
    cliIpcCall: async (method: string, params: Record<string, unknown>) => {
      state.calls.push([method, params]);
      return state.response;
    },
    exitFromIpcResult: (_r: unknown, _cmd: unknown) => {
      throw new Error("exitFromIpcResult called");
    },
  }));
  return state;
}

/**
 * Build a fresh commander program with the cloud command registered.
 * Imported lazily so the file-level mock installed by
 * {@link setupCloudIpcMock} is in place first.
 */
export async function buildCloudProgram(): Promise<Command> {
  const { registerCloudCommand } = await import("../index.js");
  const program = new Command();
  program.exitOverride();
  registerCloudCommand(program);
  return program;
}

/** Capture everything written to stdout while fn runs. */
export function captureStdout(fn: () => Promise<void>): Promise<string[]> {
  const chunks: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;
  return fn()
    .then(() => chunks)
    .finally(() => {
      process.stdout.write = origWrite;
    });
}

/** Run 'assistant cloud <args>' against a fresh program, capturing stdout. */
export async function runCloud(args: string[]): Promise<string[]> {
  const { out, thrown } = await runCloudCaught(args);
  if (thrown !== undefined) {
    throw thrown;
  }
  return out;
}

/**
 * Like {@link runCloud}, but capture whatever the parse throws instead of
 * propagating it (the mocked exitFromIpcResult error, Commander's exitOverride
 * on --help), so tests can assert on both the output and the thrown value.
 */
export async function runCloudCaught(
  args: string[],
): Promise<{ out: string[]; thrown: unknown }> {
  let thrown: unknown;
  const out = await captureStdout(async () => {
    const program = await buildCloudProgram();
    try {
      await program.parseAsync(["node", "assistant", "cloud", ...args]);
    } catch (err) {
      thrown = err;
    }
  });
  return { out, thrown };
}
