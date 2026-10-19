import type { CapacitorConfig } from "@capacitor/cli";
import baseConfig from "@mycadet/app/capacitor.config.base";

// The Android-anchored config: `cap sync android` runs from this package (the
// release workflow and `android:run` both do), so this file owns the `android`
// block and the Android-only plugin config.
const config: CapacitorConfig = {
  ...baseConfig,
  // Java-package form: Android uses this as its application namespace.
  // (iOS doesn't reuse it — its bundle IDs come from the Xcode project.)
  appId: "ai.mycadet.android",
  android: {
    // The native Gradle project is this package itself.
    path: ".",
  },
  plugins: {
    // Android-only keys: `smallIcon` names a drawable in this package's
    // res/, `iconColor` tints it. iOS ignores both.
    LocalNotifications: {
      smallIcon: "ic_stat_notification",
      iconColor: "#F6C744",
    },
  },
};

export default config;
