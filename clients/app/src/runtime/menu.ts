import { getElectronBridge } from "@app/runtime/electron-bridge";

export async function setMenuCloudSession(has: boolean): Promise<void> {
  await getElectronBridge()?.menu.setCloudSession(has);
}
