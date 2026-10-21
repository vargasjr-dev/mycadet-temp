import { isUsableRuntimeUrl } from "@mycadet/local-mode/contract";
import { isLoopbackPublicUrl } from "@mycadet/service-contracts/remote-web-pairing";
import {
  statusLocalAssistantHost,
  type LockfileAssistant,
} from "@app/assistant/local-mode-host";

export type LockfileEntryVerdict = "connect" | "recovery";

/**
 * The connect decision for one lockfile entry, shared by the chooser's
 * card-select and the shell's assistant commands (the command palette's
 * switch action and the re-pair menu item): an entry whose gateway lives on
 * another machine (a connect import — its remote `runtimeUrl` is what marks
 * it) connects outright — its resolution rides the paired-gateway path —
 * while a local entry is probed first, where anything short of a live daemon
 * earns recovery instead of a doomed connect.
 */
export async function resolveLockfileEntryConnect(
  entry: LockfileAssistant,
): Promise<LockfileEntryVerdict> {
  if (
    isUsableRuntimeUrl(entry.runtimeUrl) &&
    !isLoopbackPublicUrl(entry.runtimeUrl)
  ) {
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
