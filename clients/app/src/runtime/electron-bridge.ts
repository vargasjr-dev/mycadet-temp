import type { CadetBridge, CadetCommand } from "@mycadet/ipc-contract";

/**
 * The typed payload of a `cadet://` deep link, mirroring web's
 * `runtime/deep-links.ts` union — the same preload serves both bundles, so
 * the shapes can't drift. Only `connect` is consumed in this bundle (the
 * pairing hand-off); the chat/billing kinds belong to the web surfaces the
 * app iframes.
 */
export type DeepLink =
  | { kind: "send"; message: string }
  | { kind: "openThread"; threadId: string }
  | {
      kind: "billingCheckoutComplete";
      status: "success";
      sessionId: string;
      flow?: "subscription" | "top_up";
    }
  | {
      kind: "billingCheckoutComplete";
      status: "cancel";
      sessionId: null;
      flow?: "subscription" | "top_up";
    }
  | { kind: "connect"; url?: string; code?: string; legacy?: true }
  | { kind: "unknown"; url: string };

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
  /**
   * `cadet://` deep links the shell parsed main-side. The preload exposes
   * this to every renderer bundle it serves (web's SPA consumes it through
   * its own wrapper); the app bundle drains it for the pairing hand-off.
   * `code` is the device code — credential material, never logged.
   */
  deepLinks: {
    drain(): Promise<DeepLink[]>;
    onLink(callback: (link: DeepLink) => void): () => void;
  };
  mainWindow: {
    ensureVisible(): Promise<void>;
    setOnboarding(active: boolean): Promise<void>;
    /** The chooser's switch-to-origin: main loads the target itself. */
    navigateTo(url: string): Promise<void>;
  };
}

// Keep the adapter local to app instead of augmenting Window with web's full
// assistant bridge. The native preload owns this capability contract.
export function getElectronBridge(): AppElectronBridge | undefined {
  if (typeof window === "undefined") return undefined;
  const bridge = (window as Window & { cadet?: AppElectronBridge }).cadet;
  return bridge?.platform === "electron" ? bridge : undefined;
}
