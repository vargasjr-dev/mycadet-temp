let cached: string | null = null;

/**
 * Read the device ID from the CADET_DEVICE_ID env var. The CLI always
 * injects it when spawning the gateway (local and containerized alike);
 * without it there is no device identity.
 */
export function getDeviceId(): string | null {
  if (cached !== null) return cached;

  const envDeviceId = process.env.CADET_DEVICE_ID?.trim();
  if (envDeviceId) {
    cached = envDeviceId;
    return cached;
  }

  return null;
}
