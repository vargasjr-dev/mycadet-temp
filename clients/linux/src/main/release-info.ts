/**
 * The Linux-only release identity (the shared app/renderer constants live
 * in `@mycadet/electron-desktop/app-config`).
 */

declare const __CADET_BUILD_SHA__: string;
declare const __CADET_ENVIRONMENT__: string;

export const LINUX_RELEASE_INFO = {
  commitSha:
    typeof __CADET_BUILD_SHA__ === "string" ? __CADET_BUILD_SHA__ : "unknown",
  releaseChannel:
    typeof __CADET_ENVIRONMENT__ === "string"
      ? __CADET_ENVIRONMENT__
      : "production",
};
