import { resolveEnvironmentName } from "@mycadet/shared";

/**
 * The app's display name for this build's environment — production is
 * "Cadet", every other environment carries its channel as a suffix so
 * side-by-side installs are tellable apart. Electron-free by design: the
 * dev-app prepare script imports it from a plain Node/Bun process, where
 * the electron module cannot load.
 */
export const getAppName = () => {
  const envName = resolveEnvironmentName();
  if (envName === "production") {
    return "Cadet";
  } else {
    return `Cadet ${envName.slice(0, 1).toUpperCase()}${envName.slice(1)}`;
  }
};
