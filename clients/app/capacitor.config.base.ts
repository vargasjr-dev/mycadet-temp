import type { CapacitorConfig } from "@capacitor/cli";
// The `/seeds` subpath is deliberate: cap's TS config loader transpiles one
// file at a time and cannot resolve the environments index's `.js`-suffixed
// runtime re-exports.
import { cloudAssistantHubUrl } from "@mycadet/environments/seeds";

// Resolves the environment and app server url
function resolveServerUrl(): string {
  // The helper reads CADET_ENVIRONMENT; the sync-time default stays local.
  process.env.CADET_ENVIRONMENT ??= "local";
  return cloudAssistantHubUrl();
}

// The Capacitor config shared by all mobile shells
const baseConfig: Omit<CapacitorConfig, "appId"> = {
  appName: "Cadet",
  // cap resolves `webDir` against the config package that spreads this; both
  // sync homes (clients/ios, clients/android) are siblings of clients/app, so
  // one relative path names the built bundle from either.
  webDir: "../app/dist/capacitor",
  server: {
    // The handoff is a foreign-host navigation, and Capacitor opens those
    // externally unless the host is allowed — without this the boot would
    // bounce the user into the system browser. The entry must be a bare
    // hostname: Capacitor matches it against Swift's port-less `URL.host`
    // via a dot-split comparison, so `.host`'s `localhost:3000` never
    // matched and every local boot bounced into Safari.
    allowNavigation: [new URL(resolveServerUrl()).hostname],
  },
};

export default baseConfig;
