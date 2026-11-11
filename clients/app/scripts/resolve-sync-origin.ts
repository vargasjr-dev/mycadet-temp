import { resolveLocalServerUrl } from "@mycadet/local-mode/contract";

// Resolves the local stack's single origin the same way every other local
// surface does: the auto-tunnel's public URL when one is up (reachable from
// devices), else the app server edge's loopback port (simulator only),
// else nothing. The sync entrypoints (clients/android/scripts/build.ts,
// clients/ios/scripts/build.sh) hand the result to `cap sync` as
// `CADET_LOCAL_SERVER_URL`, which `capacitor.config.base.ts` bakes —
// the cap-loaded config itself stays on leaf-only imports.
const resolved = resolveLocalServerUrl();
if (resolved) {
  process.stdout.write(resolved);
}
