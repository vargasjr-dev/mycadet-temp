/**
 * The cloud-home test shared by the operation routers: a "cloud" entry is
 * hosted by the Cadet platform — its mechanics are the platform API, not
 * this machine's runtimes or containers.
 */
export function isCloudHome(cloud: unknown): boolean {
  return cloud === "cloud";
}
