/**
 * Resolve the cloud base URL from the `CADET_CLOUD_URL` environment
 * variable, defaulting to `https://cloud.mycadet.ai`.
 *
 * The returned URL is trimmed and has any trailing slashes removed so callers
 * can safely append path segments.
 */
export function getCloudBaseUrl(): string {
  const url = (process.env.CADET_CLOUD_URL?.trim() || "").replace(/\/+$/, "");
  return url || "https://cloud.mycadet.ai";
}

function str(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v || undefined;
}

function flag(name: string): boolean {
  const raw = str(name)?.toLowerCase();
  return raw === "true" || raw === "1";
}

export function getIsCloud(): boolean {
  return flag("IS_CLOUD");
}
