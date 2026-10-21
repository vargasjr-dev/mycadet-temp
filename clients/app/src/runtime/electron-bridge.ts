import type { CadetBridge, CadetCommand } from "@mycadet/ipc-contract";

/** Native host capabilities currently used by the account client. */
export interface AppElectronBridge {
  platform: "electron";
  auth?: Partial<
    Pick<
      CadetBridge["auth"],
      "getSessionToken" | "cancelOAuth" | "startOAuth" | "signOut"
    >
  >;
  localMode?: Pick<CadetBridge["localMode"], "readLockfile">;
  menu: { setCloudSession(has: boolean): Promise<void> };
  commands: {
    on(callback: (command: CadetCommand) => void): () => void;
  };
  mainWindow: {
    ensureVisible(): Promise<void>;
    setOnboarding(active: boolean): Promise<void>;
    /** The chooser's switch-to-origin: main loads the target itself. */
    navigateTo(url: string): Promise<void>;
  };
  /**
   * Deep-link bridge (deep-links.ts): `drain` returns links that arrived
   * before the renderer existed, `onLink` subscribes to live ones. Optional
   * so a renderer newer than its shell degrades to no links instead of
   * throwing inside the effect.
   */
  deepLinks?: Pick<CadetBridge["deepLinks"], "drain" | "onLink">;
}

// Keep the adapter local to app instead of augmenting Window with web's full
// assistant bridge. The native preload owns this capability contract.
export function getElectronBridge(): AppElectronBridge | undefined {
  if (typeof window === "undefined") return undefined;
  const bridge = (window as Window & { cadet?: AppElectronBridge }).cadet;
  return bridge?.platform === "electron" ? bridge : undefined;
}
