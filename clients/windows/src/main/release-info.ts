/**
 * The Windows-only release identity (the shared app/renderer constants
 * live in `@mycadet/electron-desktop/app-config`).
 */

declare const __CADET_APP_USER_MODEL_ID__: string;
declare const __CADET_BUILD_SHA__: string;
declare const __CADET_ENVIRONMENT__: string;

export const WINDOWS_RELEASE_INFO = {
  // Injected from electron-builder.config.cjs `appId` at build time.
  appUserModelId:
    typeof __CADET_APP_USER_MODEL_ID__ === "string"
      ? __CADET_APP_USER_MODEL_ID__
      : "ai.mycadet.electron",
  commitSha:
    typeof __CADET_BUILD_SHA__ === "string" ? __CADET_BUILD_SHA__ : "unknown",
  releaseChannel:
    typeof __CADET_ENVIRONMENT__ === "string"
      ? __CADET_ENVIRONMENT__
      : "production",
};
