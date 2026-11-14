import type { CapacitorConfig } from "@capacitor/cli";
import { KeyboardResize, KeyboardStyle } from "@capacitor/keyboard";
import {
  resolveEnvironmentName,
  type CadetEnvironment,
} from "@mycadet/shared/seeds";
import baseConfig from "@mycadet/app/capacitor.config.base";

// Keyed by the union the seeds file owns: adding an environment without
// deciding its scheme is a compile error, and the lookup below needs no
// `??` fallback.
const SCHEME_NAMES: Record<CadetEnvironment, string> = {
  production: "App",
  staging: "App Staging",
  dev: "App Dev",
  local: "App Local",
  // No dedicated test scheme exists — the test seed is for port-blocked
  // service environments, so a sync against it bakes test cloud into the
  // production scheme's bundle.
  test: "App",
};

// The iOS-anchored config: `cap sync ios` runs from this package (the release
// workflow and this package's setup script both do), so this file owns the
// `ios` block and the iOS-only plugin config.
const config: CapacitorConfig = {
  ...baseConfig,
  // Capacitor requires a Java-package-form appId; iOS doesn't consume it —
  // the real per-environment bundle IDs live in `App/App/Config/*.xcconfig`.
  appId: "ai.mycadet.ios",
  ios: {
    // The native Xcode project is this package itself.
    path: ".",
    // `never` = WKWebView leaves safe-area compensation to the page's
    // `env(safe-area-inset-*)` (PRs #4821/#4832 assume it); the default
    // `.automatic` zeroes those insets and pads the scroll content itself,
    // hiding the header/composer under the notch and home indicator.
    contentInset: "never",
    scheme: SCHEME_NAMES[resolveEnvironmentName("local")],
  },
  plugins: {
    // Spreads the base config's shared plugin block (`CadetCloud` — the
    // baked cloud origin the native half dials) alongside the iOS-only
    // keys below; a literal here would drop the shared entries.
    ...baseConfig.plugins,
    Keyboard: {
      // `native` resizes the whole WKWebView frame above the keyboard, which
      // `src/hooks/use-visible-viewport.ts` measures against; `body`,
      // `ionic`, and `none` break that keyboard-height derivation.
      resize: KeyboardResize.Native,
      // Track the device appearance — the plugin swizzles it process-wide,
      // and no `style` value expresses "follow the in-app theme".
      style: KeyboardStyle.Default,
      // Paints the window from the body's computed background on keyboard
      // show, avoiding the iOS 26 transparent-keyboard black flash. The
      // plugin's parser handles rgb()/hex/`transparent` only — a token
      // migration to oklch()/color() would flash white and revisit this.
      autoBackdropColor: "dom",
    },
  },
};

export default config;
