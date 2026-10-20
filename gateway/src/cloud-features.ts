/**
 * Cloud-feature gating for the gateway.
 *
 * Cloud features (email callbacks, Telegram webhooks, guardian bootstrap
 * against the cloud, record-activity pings) are on for every build except a
 * local one that explicitly opts out with `CADET_DISABLE_CLOUD`.
 */

export function isCloudServedBuild(): boolean {
  const v = process.env.IS_CLOUD?.trim().toLowerCase();
  return v === "true" || v === "1";
}

export function areCloudFeaturesEnabled(): boolean {
  if (isCloudServedBuild()) return true;
  const v = process.env.CADET_DISABLE_CLOUD?.trim().toLowerCase();
  return !(v === "true" || v === "1");
}
