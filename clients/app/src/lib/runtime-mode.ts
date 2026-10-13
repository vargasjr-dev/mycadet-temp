const PLATFORM_MODE_TRUTHY = new Set(["1", "true", "yes"]);

export function isLocalClient(): boolean {
  const raw = import.meta.env.VITE_CLOUD_MODE;
  if (!raw) {
    return true;
  }
  return !PLATFORM_MODE_TRUTHY.has(raw.toLowerCase());
}
