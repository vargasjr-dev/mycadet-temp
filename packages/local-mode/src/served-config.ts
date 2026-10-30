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
    // Baseten serving identity: the sandbox URL and its pinned gateway port,
    // so the served bundle can address `{sandboxUrl}/port/{gatewayPort}`.
    sandboxUrl: served?.cloud === "baseten" ? served.sandboxUrl : undefined,
    gatewayPort: served?.cloud === "baseten" ? served.port : undefined,
  };
}
