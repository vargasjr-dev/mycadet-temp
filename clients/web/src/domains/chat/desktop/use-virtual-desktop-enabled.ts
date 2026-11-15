/**
 * The virtual desktop preview renders for every assistant — the hosting
 * check that used to limit it to cloud-hosted ones died with the de-cloud
 * sweep. The stream surfaces its own state when the runtime has no desktop.
 */
export function useVirtualDesktopEnabled(): boolean {
  return true;
}
