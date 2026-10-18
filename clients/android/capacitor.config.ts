import type { CapacitorConfig } from "@capacitor/cli";
import baseConfig from "../app/capacitor.config.base";

// The Android-anchored config: `cap sync android` runs from this package (the
// release workflow and `android:run` both do), so this file owns the `android`
// block. Everything shared — the app id, server URL resolution, and the
// plugin config — comes from the base config in `clients/app`.
const config: CapacitorConfig = {
  ...baseConfig,
  // `webDir` is resolved relative to the config file's own location, and the
  // built shell lives in `clients/app`, so the override is the same directory
  // the base's `"capacitor-shell"` names, expressed from over here.
  webDir: "../app/capacitor-shell",
  android: {
    // The native Gradle project is this package itself.
    path: ".",
  },
};

export default config;
