import type { CapacitorConfig } from "@capacitor/cli";
// The `/environment-seeds` subpath is deliberate: cap's TS config loader
// transpiles one file at a time — only the self-contained seeds file is
// safe to import here. The local stack's lockfile resolution happens in
// the sync entrypoints (plain bun scripts), which hand the resolved URL
// over as `CADET_LOCAL_SERVER_URL`.
import { SEEDS } from "@mycadet/local-mode/environment-seeds";

// Resolves the environment and app server url
function resolveServerUrl(): string {
  // The helper reads CADET_ENVIRONMENT; the sync-time default stays local.
  process.env.CADET_ENVIRONMENT ??= "local";
  return SEEDS[process.env.CADET_ENVIRONMENT]?.baseUrl ?? SEEDS.dev.baseUrl;
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
    // The sync entrypoints look the local stack up from the lockfile
    // before syncing (tunnel URL for devices, the app server edge's
    // loopback port for the simulator); the seed's default port is the
    // fallback when no stack is up.
    return process.env.CADET_LOCAL_SERVER_URL || SEEDS.local.baseUrl;
  }
  return SEEDS[process.env.CADET_ENVIRONMENT!]?.baseUrl ?? SEEDS.dev.baseUrl;
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
