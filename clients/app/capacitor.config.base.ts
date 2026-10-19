import type { CapacitorConfig } from "@capacitor/cli";
// The `/seeds` subpath is deliberate: cap's TS config loader transpiles one
// file at a time and cannot resolve the environments index's `.js`-suffixed
// runtime re-exports.
import { cloudAssistantHubUrl } from "@mycadet/environments/seeds";

// `server.url` is baked into native Capacitor config by `cap sync`, so
// whatever URL resolves here at sync time is what the archived mobile build
// ships with. Defaults to local — the simulator shares the host's loopback,
// so a locally-synced shell talks to the local dev server (`cadet client`).
// The release workflows always set `CADET_ENVIRONMENT`; `CADET_SERVER_URL`
// overrides with an https origin for self-hosted assistants.
function resolveServerUrl(): string {
  const override = process.env.CADET_SERVER_URL?.trim();
  if (!override) {
    return cloudAssistantHubUrl(process.env.CADET_ENVIRONMENT ?? "local");
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

// The Capacitor config shared by both platform shells: clients/ios and
// clients/android spread this and add their own appId, platform block, and
// platform-owned plugin config — nothing here is platform-specific.
const baseConfig: Omit<CapacitorConfig, "appId"> = {
  appName: "Cadet",
  server: {
    url: resolveServerUrl(),
    cleartext: false,
  },
  // cap resolves `webDir` against the config package that spreads this; both
  // sync homes (clients/ios, clients/android) are siblings of clients/app, so
  // one relative path names the built shell from either.
  webDir: "../app/capacitor-shell",
};

export default baseConfig;
