import type { IpcRenderer } from "electron";

import type { VellumBridge } from "@mycadet/ipc-contract";

type RendererIpc = Pick<IpcRenderer, "invoke">;

export const createLocalModeBridge = (
  ipc: RendererIpc,
): VellumBridge["localMode"] => ({
  guardianToken: (assistantId) =>
    ipc.invoke("cadet:localMode:guardianToken", assistantId),
  hatch: (remote) => ipc.invoke("cadet:localMode:hatch", remote),
  listDevices: (assistantId) =>
    ipc.invoke("cadet:localMode:listDevices", assistantId),
  pairingCancel: (handle) =>
    ipc.invoke("cadet:localMode:pairingCancel", handle),
  pairingPoll: (handle, name) =>
    ipc.invoke("cadet:localMode:pairingPoll", handle, name),
  pairingStart: (address) =>
    ipc.invoke("cadet:localMode:pairingStart", address),
  readAssistantAvatar: (assistantId) =>
    ipc.invoke("cadet:localMode:readAssistantAvatar", assistantId),
  readLockfile: () => ipc.invoke("cadet:localMode:readLockfile"),
  renameLockfileAssistant: (assistantId, name) =>
    ipc.invoke("cadet:localMode:renameLockfileAssistant", assistantId, name),
  stampLockfileAssistantOnboarded: (assistantId, onboardedAt) =>
    ipc.invoke(
      "cadet:localMode:stampLockfileAssistantOnboarded",
      assistantId,
      onboardedAt,
    ),
  replacePlatformAssistants: (assistants, organizationId) =>
    ipc.invoke(
      "cadet:localMode:replacePlatformAssistants",
      assistants,
      organizationId,
    ),
  retire: (assistantId) => ipc.invoke("cadet:localMode:retire", assistantId),
  revokeDevice: (assistantId, hashedDeviceId) =>
    ipc.invoke("cadet:localMode:revokeDevice", assistantId, hashedDeviceId),
  saveLockfileAssistant: (assistant, activeAssistant) =>
    ipc.invoke(
      "cadet:localMode:saveLockfileAssistant",
      assistant,
      activeAssistant,
    ),
  sleep: (assistantId) => ipc.invoke("cadet:localMode:sleep", assistantId),
  status: (assistantId) => ipc.invoke("cadet:localMode:status", assistantId),
  unpair: (assistantId) => ipc.invoke("cadet:localMode:unpair", assistantId),
  upgrade: (assistantId, options) =>
    ipc.invoke("cadet:localMode:upgrade", assistantId, options),
  wake: (assistantId, options) =>
    ipc.invoke("cadet:localMode:wake", assistantId, options),
});
