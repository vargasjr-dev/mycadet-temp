/**
 * The app's global surface: the Electron preload's `window.cadet` bridge
 * (the shared `@mycadet/ipc-contract` shape, re-declared in
 * `runtime/electron-bridge.ts`'s local adapter — the app does NOT inherit
 * web's fuller Window augmentation). The injected runtime config is gone:
 * the shell is served by the host it talks to, and no build stamps config
 * into its bundle anymore.
 */
interface Window {
  /** Feature flag overrides injected by Electron preload or CLI script. */
  /** The Electron preload bridge — the shared `@mycadet/ipc-contract` shape. */
  cadet?: import("@mycadet/ipc-contract").CadetBridge;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
