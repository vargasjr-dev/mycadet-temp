import type { CapacitorConfig } from "@capacitor/cli";
import baseConfig from "./capacitor.config.base";

// `server.url` is baked into native Capacitor config by `cap sync`, so the
// environment selection happens in the base config (`capacitor.config.base.ts`).

const SCHEME_NAMES: Record<string, string> = {
  production: "App",
  staging: "App Staging",
  dev: "App Dev",
  local: "App Local",
};

// The iOS-anchored config: `cap sync ios` runs from this package (the release
// workflow and `clients/ios`'s setup script both do), so this file owns the
// `ios` block. The native iOS project lives as a peer to `clients/app/` at
// `clients/ios/`, not nested inside the app package. This keeps the Capacitor
// shell alongside the other client apps (`clients/web`, `clients/android`, …)
// rather than burying it inside any one of them.
const config: CapacitorConfig = {
  ...baseConfig,
  webDir: "capacitor-shell",
  ios: {
    path: "../ios",
    // Map to `WKWebView.scrollView.contentInsetAdjustmentBehavior = .never`.
    // Without this, iOS WKWebView defaults to `.automatic` and pads the
    // scroll content by the safe-area insets itself, which has two
    // unwanted effects inside the Capacitor shell:
    //   1. `env(safe-area-inset-*)` resolves to 0 because, from the
    //      webview's perspective, it already sits inside the safe area.
    //      That makes the CSS safe-area padding on `<Layout>` /
    //      `<AssistantShell>` a no-op — the header and composer end up
    //      covered by the notch and home indicator.
    //   2. The surface colour on the header stops at the safe-area line
    //      instead of extending into the notch, leaving a transparent
    //      strip at the top.
    // Setting this to `never` lets the page own the inset compensation via
    // `env(safe-area-inset-*)`, which is what PRs #4821 and #4832 assume.
    contentInset: "never",
    scheme: SCHEME_NAMES[process.env.CADET_ENVIRONMENT ?? "local"] ?? "App",
  },
};

export default config;
