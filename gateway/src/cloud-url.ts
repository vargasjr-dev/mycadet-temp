/**
 * Resolve the platform base URL from the `CADET_PLATFORM_URL` environment
 * variable. Returns `undefined` when unset.
 *
 * The returned URL is trimmed and has any trailing slashes removed so callers
 * can safely append path segments.
 */
export function getCloudBaseUrl(): string | undefined {
  const url = (
    process.env.CADET_PLATFORM_URL?.trim() || ""
  ).replace(/\/+$/, "");
  return url || undefined;
}
