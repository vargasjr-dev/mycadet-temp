import type { CadetCommand } from "@mycadet/ipc-contract";

/** Native host capabilities currently used by the account client. */
export interface AppElectronBridge {
  platform: "electron";
  auth?: { getSessionToken?(): string | null };
  menu: { setCloudSession(has: boolean): Promise<void> };
  commands: {
    on(callback: (command: CadetCommand) => void): () => void;
  };
  mainWindow: {
    ensureVisible(): Promise<void>;
    setOnboarding(active: boolean): Promise<void>;
  };
}

// Keep the adapter local to app instead of augmenting Window with web's full
// assistant bridge. The native preload owns this capability contract.
export function getElectronBridge(): AppElectronBridge | undefined {
  if (typeof window === "undefined") return undefined;
  const bridge = (window as Window & { cadet?: AppElectronBridge }).cadet;
  return bridge?.platform === "electron" ? bridge : undefined;
}
