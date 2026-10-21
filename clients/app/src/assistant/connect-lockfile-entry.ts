import {
  isPairedAssistant,
  statusLocalAssistantHost,
  type LockfileAssistant,
} from "@app/assistant/local-mode-host";

/**
 * Where a lockfile entry's same-origin API base lives. Paired gateways ride
 * the shell's paired-forward path: same-origin, allowlisted by the lockfile
 * entry, guardian credential injected server-side. Absent for local
 * entries, which resolve same-origin as before.
 */
export function entryApiBase(entry: LockfileAssistant): string | undefined {
  return isPairedAssistant(entry)
    ? `/assistant/__gateway-paired/${entry.assistantId}`
    : undefined;
}

export type LockfileEntryVerdict = "connect" | "recovery";

/**
 * The connect decision for one lockfile entry, shared by the chooser's
 * card-select and the shell's assistant commands (the command palette's
 * switch action and the re-pair menu item): paired entries connect
 * outright — their resolution rides the paired-gateway path — while a local
 * entry is probed first, where anything short of a live daemon earns
 * recovery instead of a doomed connect.
 */
export async function resolveLockfileEntryConnect(
  entry: LockfileAssistant,
): Promise<LockfileEntryVerdict> {
  if (isPairedAssistant(entry)) {
    return "connect";
  }
  try {
    const status = await statusLocalAssistantHost(entry.assistantId);
    if (
      status.ok &&
      (status.state === "healthy" ||
        status.state === "starting" ||
        status.state === "upgrading")
    ) {
      return "connect";
    }
  } catch (error) {
    // A thrown transport error is the same "can't verify it's healthy" the
    // non-ok statuses are; the caller routes it to recovery.
    console.error("resolveLockfileEntryConnect probe failed", error);
  }
  return "recovery";
}
