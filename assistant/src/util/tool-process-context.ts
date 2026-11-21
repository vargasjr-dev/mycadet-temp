import { AsyncLocalStorage } from "node:async_hooks";
import type { ChildProcess } from "node:child_process";

export interface ToolProcessOwner {
  toolName: string;
  conversationId: string;
}

const context = new AsyncLocalStorage<ToolProcessOwner>();
const owners = new Map<number, ToolProcessOwner>();

/** Keep concurrent tool invocations isolated across awaits. */
export function runInToolProcessContext<T>(
  owner: ToolProcessOwner,
  run: () => T,
): T {
  return context.run(owner, run);
}

/** Track shell/skill roots; descendants inherit their nearest root's owner. */
export function trackToolProcess(
  child: ChildProcess,
  fallback: ToolProcessOwner,
): void {
  const owner = context.getStore() ?? fallback;
  const pid = child.pid;
  if (pid == null) {
    return;
  }
  owners.set(pid, owner);
  const forget = () => {
    if (owners.get(pid) === owner) {
      owners.delete(pid);
    }
  };
  child.once("close", forget);
  child.once("error", forget);
}

export function getToolProcessOwner(pid: number): ToolProcessOwner | undefined {
  return owners.get(pid);
}
