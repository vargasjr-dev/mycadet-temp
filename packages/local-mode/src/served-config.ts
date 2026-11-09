import type { Lockfile, LockfileAssistant } from "./lockfile-contract";

/**
 * The lockfile entry the app server fronts: the active assistant, or the
 * sole entry before one is picked. The one selection rule, shared by the
 * served config (`servedConfigFromLockfile`) and the edge's websocket relay
 * target.
 */
export function servedAssistantFromLockfile(
  lockfile: Lockfile,
): LockfileAssistant | undefined {
  return (
    lockfile.assistants.find(
      (assistant) => assistant.assistantId === lockfile.activeAssistant,
    ) ??
    (lockfile.assistants.length === 1 ? lockfile.assistants[0] : undefined)
  );
}

/** Public identity of the active assistant, or the sole entry before selection. */
export function servedConfigFromLockfile(lockfile: Lockfile) {
  const served = servedAssistantFromLockfile(lockfile);
  return {
    assistantId: served?.assistantId,
    assistantName: served?.name,
    remote: served?.cloud,
  };
}
