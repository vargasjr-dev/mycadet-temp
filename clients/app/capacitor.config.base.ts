import type { CapacitorConfig } from "@capacitor/cli";
// The `/seeds` subpath is deliberate: cap's TS config loader transpiles one
// file at a time and cannot resolve the environments index's `.js`-suffixed
// runtime re-exports.
import {
  SEEDS,
  cloudAssistantHubUrl,
  cloudWebUrl,
} from "@mycadet/environments/seeds";

// Resolves the environment and app server url
function resolveServerUrl(): string {
  // The helper reads CADET_ENVIRONMENT; the sync-time default stays local.
  process.env.CADET_ENVIRONMENT ??= "local";
  return cloudAssistantHubUrl();
}

// The baked cloud origin the mobile shells' native half dials: the iOS
// scheme handler forwards the boot bundle's same-origin `/v1` fetches at
// it, and it is the baked-default fallback behind the chooser escape and
// the widget identity. Resolved at sync time from `CADET_ENVIRONMENT` —
// the same input the removed `__CADET_CONFIG__` stamp consumed, carried
// natively now that the served-bundle config schema transports no URLs.
// Local resolves to the control-plane default; a lockfile-dialed
// tunnel/loopback stack for a device build is the mobile iteration's
// follow-up (the stamp's own fallback, unchanged).
function resolveBakedCloudUrl(): string {
  if ((process.env.CADET_ENVIRONMENT ??= "local") === "local") {
    return SEEDS.local.cloudUrl;
  }
  return cloudWebUrl();
}

// The Capacitor config shared by all mobile shells
const baseConfig: Omit<CapacitorConfig, "appId"> = {
  appName: "Cadet",
  // cap resolves `webDir` against the config package that spreads this; both
  // sync homes (clients/ios, clients/android) are siblings of clients/app, so
  // one relative path names the built bundle from either.
  webDir: "../app/dist/capacitor",
  plugins: {
    // Inert to Capacitor itself — the mobile shells' native half reads the
    // baked origin out of the synced config (SelfHostedServer on iOS).
    CadetCloud: {
      cloudUrl: resolveBakedCloudUrl(),
    },
  },
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
