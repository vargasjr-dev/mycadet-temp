import type { CapacitorConfig } from "@capacitor/cli";
// The `/seeds` subpath is deliberate: cap's TS config loader transpiles one
// file at a time and cannot resolve a re-export barrel — nor any deeper
// import chain, which is why the standalone seeds file (its resolver keeps
// zero static imports) is the one shared import here.
import { getCloudBaseUrl } from "@mycadet/shared/seeds";

// The Capacitor config shared by all mobile shells
const baseConfig: Omit<CapacitorConfig, "appId"> = {
  appName: "Cadet",
  // cap resolves `webDir` against the config package that spreads this; both
  // sync homes (clients/ios, clients/android) are siblings of clients/app, so
  // one relative path names the built bundle from either.
  webDir: "../app/dist/capacitor",
  plugins: {
    // Inert to Capacitor itself — the mobile shells' native half reads the
    // baked origin out of the synced config (SelfHostedServer on iOS). It is
    // the environment's single origin — the iOS scheme handler forwards the
    // boot bundle's same-origin `/v1` fetches at it, and it is the
    // baked-default fallback behind the chooser escape and the widget
    // identity. `CADET_ENVIRONMENT` at sync time picks the seed; there is no
    // fallback argument to hide an unset environment.
    CadetCloud: {
      cloudUrl: getCloudBaseUrl(),
    },
  },
  server: {
    // The handoff is a foreign-host navigation, and Capacitor opens those
    // externally unless the host is allowed — without this the boot would
    // bounce the user into the system browser. The entry must be a bare
    // hostname: Capacitor matches it against Swift's port-less `URL.host`
    // via a dot-split comparison, so `.host`'s `localhost:3000` never
    // matched and every local boot bounced into Safari.
    allowNavigation: [new URL(getCloudBaseUrl()).hostname],
  },
};

export default baseConfig;
