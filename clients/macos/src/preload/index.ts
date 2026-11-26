// The whole preload — composition and `exposeInMainWorld` — lives in the
// electron-desktop package; this shell's entry just imports it.
// `bridge-parity.test.ts` holds the composed bridge to the full contract.
import "@mycadet/electron-desktop/preload";
