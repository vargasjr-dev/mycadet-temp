/**
 * Whether a lockfile entry's cloud value denotes the platform-managed
 * topology. `cloud` is the canonical spelling; `vellum` is the legacy
 * spelling still present in pre-rebrand lockfiles, and every reader that
 * used to compare `=== "vellum"` switches on this instead so both spellings
 * dispatch identically.
 */
export function isManagedCloud(cloud: unknown): boolean {
  return cloud === "cloud" || cloud === "vellum";
}
