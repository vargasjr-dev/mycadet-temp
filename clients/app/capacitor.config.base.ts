import type { CapacitorConfig } from "@capacitor/cli";
// The `/seeds` subpath is deliberate: cap's TS config loader transpiles one
// file at a time and cannot resolve the environments index's `.js`-suffixed
// runtime re-exports.
import { cloudAssistantHubUrl } from "@mycadet/environments/seeds";

// Resolves the environment the same way the build stamps `__CADET_CONFIG__`
// (`build:capacitor` → `src/capacitor/stamp.ts`). The shell boots on its own
// origin and the scheme handler forwards `/v1`, so this only lists the
// environment's host as a navigation escape hatch. The release workflows
// always set `CADET_ENVIRONMENT`; unset means the local cadet.
function resolveServerUrl(): string {
  // The helper reads CADET_ENVIRONMENT; the sync-time default stays local.
  process.env.CADET_ENVIRONMENT ??= "local";
  return cloudAssistantHubUrl();
}

// The Capacitor config shared by both platform shells: clients/ios and
// clients/android spread this and add their own appId, platform block, and
// platform-owned plugin config — nothing here is platform-specific.
//
// `webDir` points at the BAKED app-shell boot bundle (clients/app's
// `build:capacitor` output — every sync flow runs it before `cap sync`).
// The bundle renders the initial Cadet screens from local assets with zero
// network, then hands off to the environment's assistant entry through the
// `handoffUrl` its build stamps into `__CADET_CONFIG__`. There is no
// `server.url` anymore: the webview boots on the baked shell, not on a
// network URL, so the first paint no longer waits on the network.
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
