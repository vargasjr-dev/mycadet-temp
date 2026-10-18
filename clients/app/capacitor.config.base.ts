import type { CapacitorConfig } from "@capacitor/cli";
import { KeyboardResize, KeyboardStyle } from "@capacitor/keyboard";
// The `/seeds` subpath (not the package index) is deliberate: Capacitor's
// node-based TS config loader transpiles one file at a time and cannot
// resolve the index's `.js`-suffixed runtime re-exports, while the seeds
// module is self-contained (type-only imports) and loads cleanly.
import { cloudAssistantHubUrl } from "@mycadet/environments/seeds";

// `server.url` is baked into native Capacitor config by `cap sync`, so
// whatever URL resolves here at sync time is what the archived mobile build
// ships with. Defaults to local — the simulator shares the host's loopback,
// so a locally-synced shell talks to the local dev server (`cadet client`)
// and the assistant hatched beside it (`cadet-local hatch`). For a real
// device, resync with an explicit `CADET_ENVIRONMENT` (the release workflows
// always set it) or point `CADET_SERVER_URL` at an https origin.
//
// The environment-to-hub mapping (including the deliberate `/assistant`
// suffix) is shared with the CLI's remote-web edge via
// `@mycadet/environments`; see `cloudAssistantHubUrl` for the rationale.
const env = process.env.CADET_ENVIRONMENT ?? "local";

const ENV_SERVER_URL = cloudAssistantHubUrl(env);

// `CADET_SERVER_URL` points the shell at a self-hosted assistant's own HTTPS
// origin, taking precedence over the environment-derived Cadet Cloud URL. It
// must parse as an `https:` URL and `server.cleartext` stays false, so an
// invalid value fails `cap sync` loudly instead of baking a broken URL into a
// native build.
function resolveServerUrl(): string {
  const override = process.env.CADET_SERVER_URL?.trim();
  if (!override) {
    return ENV_SERVER_URL;
  }

  let parsed: URL;
  try {
    parsed = new URL(override);
  } catch {
    throw new Error(
      `CADET_SERVER_URL is not a valid URL: ${JSON.stringify(override)}`,
    );
  }

  if (parsed.protocol !== "https:") {
    throw new Error(
      `CADET_SERVER_URL must use https: (got ${JSON.stringify(override)}); native builds require valid TLS.`,
    );
  }

  return override;
}

// The base config shared by every Capacitor shell. Each native platform's
// own `capacitor.config.ts` (clients/app for iOS, clients/android for
// Android) spreads this and adds its platform block — paths in
// `ios`/`android`/`webDir` are relative to each config's own location, so
// platform configs override them rather than inherit them.
const baseConfig: CapacitorConfig = {
  // NOTE: Capacitor's CLI requires Java-package form here because Android
  // uses this value as its application namespace. The real iOS bundle IDs are
  // set via `PRODUCT_BUNDLE_IDENTIFIER` in the Xcode project.
  appId: "ai.mycadet.android",
  appName: "Cadet",
  server: {
    url: resolveServerUrl(),
    cleartext: false,
  },
  // The plugin owns keyboard avoidance on iOS: its `load()` removes the web
  // view's own keyboard notification observers and resizes the frame itself.
  // Pin both iOS knobs to the behavior the app already depends on so an
  // upstream default change cannot move them silently.
  plugins: {
    LocalNotifications: {
      smallIcon: "ic_stat_notification",
      iconColor: "#F6C744",
    },
    Keyboard: {
      // `native` resizes the whole WKWebView frame above the keyboard, which
      // is what `src/hooks/use-visible-viewport.ts` measures against
      // (`innerHeight` and `visualViewport.height` shrink together). `body`,
      // `ionic`, and `none` leave the frame at full height and break that
      // keyboard-height derivation.
      resize: KeyboardResize.Native,
      // `DEFAULT` follows the device appearance. The plugin swizzles
      // `keyboardAppearance` on `WKContentView` and `UITextInputTraits`
      // process-wide to whatever is set here, so the soft keyboard tracks the
      // iOS Settings appearance and never the in-app light/dark/velvet theme.
      // No `style` value expresses "follow the in-app theme"; that needs a
      // runtime `Keyboard.setStyle()` call.
      style: KeyboardStyle.Default,
      // The iOS 26 keyboard is a transparent inset panel with rounded
      // corners. Under `resize: native` the shrunk web view is the view
      // controller's root view, so the unpainted UIWindow composites black
      // through the panel's margins and corners. `"dom"` paints the window
      // from the body's computed background (`--surface-base` on the iOS
      // shell, via the gated rule in `index.css`) at plugin load and on
      // every `keyboardWillShow`.
      // Caution: the plugin's DOM color parser handles `rgb()`/hex/
      // `transparent` and falls back to white for anything else. Today's
      // tokens compute to `rgb()`, but a token migration to `oklch()` or
      // `color()` would flash white behind the keyboard and must revisit
      // this setting.
      autoBackdropColor: "dom",
    },
  },
};

export default baseConfig;
