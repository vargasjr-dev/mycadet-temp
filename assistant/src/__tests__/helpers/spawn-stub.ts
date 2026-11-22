import type { Subprocess } from "bun";

/**
 * The child surface the worker lifecycle actually reads: pid, the exit
 * promise, and the two liveness methods.
 */
export type WorkerStubChild = {
  pid: number;
  exited?: Promise<number>;
  kill?: () => void;
  unref?: () => void;
};

/**
 * A `Subprocess`-shaped double for spawn stubs. Every member the worker
 * lifecycle ignores is inert: the stdio pipes were spawned "ignore" (so the
 * readable sides are null), there is no terminal, and the process is neither
 * exited nor killed until the test's own promise settles.
 */
export function fakeSubprocess(
  child: WorkerStubChild,
): Subprocess<"ignore", "ignore", number | "ignore"> {
  return {
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    stdio: [null, null, null],
    readable: undefined,
    terminal: undefined,
    pid: child.pid,
    exited: child.exited ?? new Promise(() => {}),
    exitCode: null,
    signalCode: null,
    killed: false,
    kill: child.kill ?? (() => {}),
    ref: () => {},
    unref: child.unref ?? (() => {}),
    send: () => {},
    disconnect: () => {},
    resourceUsage: () => undefined,
    [Symbol.asyncDispose]: async () => {},
  };
}
