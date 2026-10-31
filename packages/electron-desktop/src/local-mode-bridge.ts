import type { IpcRenderer } from "electron";

import type { CadetBridge } from "@mycadet/ipc-contract";

type RendererIpc = Pick<IpcRenderer, "invoke">;

export const createLocalModeBridge = (
  ipc: RendererIpc,
): CadetBridge["localMode"] => ({
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
  retire: (assistantId) => ipc.invoke("cadet:localMode:retire", assistantId),
  revokeDevice: (assistantId, hashedDeviceId) =>
    ipc.invoke("cadet:localMode:revokeDevice", assistantId, hashedDeviceId),
  sleep: (assistantId) => ipc.invoke("cadet:localMode:sleep", assistantId),
  status: (assistantId) => ipc.invoke("cadet:localMode:status", assistantId),
  unpair: (assistantId) => ipc.invoke("cadet:localMode:unpair", assistantId),
  upgrade: (assistantId, options) =>
    ipc.invoke("cadet:localMode:upgrade", assistantId, options),
  wake: (assistantId, options) =>
    ipc.invoke("cadet:localMode:wake", assistantId, options),
});
