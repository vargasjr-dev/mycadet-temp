import type { Lockfile } from "./lockfile-contract";

/** Public identity of the active assistant, or the sole entry before selection. */
export function servedConfigFromLockfile(lockfile: Lockfile) {
  const served =
    lockfile.assistants.find(
      (assistant) => assistant.assistantId === lockfile.activeAssistant,
    ) ??
    (lockfile.assistants.length === 1 ? lockfile.assistants[0] : undefined);
  return {
    assistantId: served?.assistantId,
    assistantName: served?.name,
    remote: served?.cloud,
  };
}
