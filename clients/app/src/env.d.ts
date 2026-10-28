/**
 * The app's global surface: the injected runtime config (stamped by the
 * Capacitor shell, the desktop shim, or the CLI script — `readInjectedConfig`
 * is the parse boundary) and the feature-flag overrides the Electron preload
 * injects. The `window.cadet` bridge shape lives in `@mycadet/ipc-contract`
 * and is re-declared in `runtime/electron-bridge.ts`'s local adapter — the
 * app does NOT inherit web's fuller Window augmentation.
 */
interface Window {
  /** Runtime config injected by the shell (Electron preload, CLI, etc.). */
  /** Raw host-injected config; `readInjectedConfig` is the parse boundary. */
  __CADET_CONFIG__?: unknown;
  /** Feature flag overrides injected by Electron preload or CLI script. */
  /** The Electron preload bridge — the shared `@mycadet/ipc-contract` shape. */
  cadet?: import("@mycadet/ipc-contract").CadetBridge;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
