/**
 * Cloud-feature gating for the gateway.
 *
 * Cloud features (email callbacks, Telegram webhooks, guardian bootstrap
 * against the cloud, record-activity pings) are always on.
 * `isCloudServedBuild` marks the cloud-served deployment, which webhook
 * routing consults.
 */

export function isCloudServedBuild(): boolean {
  const v = process.env.IS_CLOUD?.trim().toLowerCase();
  return v === "true" || v === "1";
}
