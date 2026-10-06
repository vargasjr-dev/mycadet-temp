export function isManagedCloud(cloud: unknown): boolean {
  return cloud === "cloud" || cloud === "vellum";
}
