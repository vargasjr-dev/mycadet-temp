/**
 * The credential Cadet Cloud provisions onto a cloud assistant pod for
 * its own use: the API key the daemon authenticates to the cloud LLM proxy
 * with.
 *
 * The cloud writes it over `POST /v1/secrets`, and the daemon, the
 * gateway, and CES read it straight out of the vault. The user never sets it
 * through the credentials API and can do nothing useful with it there, so
 * that API treats it as neither readable nor writable: omitted from listings,
 * and refused by inspect, reveal, set, and delete, whatever the calling
 * principal.
 *
 * The key spends inference on Cadet's account; the host it is sent to
 * resolves from config or the `CADET_CLOUD_URL` environment variable, so
 * there is no stored URL credential to guard alongside it.
 */
// The cloud pushes the pre-rebrand display name ("cadet:*"); the
// canonical storage service is "cadet".
const MANAGED_PROXY_CREDENTIALS = [
  { service: "cadet", field: "assistant_api_key" },
] as const;

export function isPlatformCloudCredential(
  service: string,
  field: string,
): boolean {
  return MANAGED_PROXY_CREDENTIALS.some(
    (c) => c.service === service && c.field === field,
  );
}

/** What a caller was trying to do with a cloud credential. */
export type PlatformCloudCredentialAction = "read" | "change";

/** Message the credentials API refuses one of these with. */
export function platformCloudCredentialRefusal(
  service: string | undefined,
  field: string | undefined,
  action: PlatformCloudCredentialAction,
): string {
  const name = service && field ? `${service}:${field}` : "This credential";
  const verb =
    action === "read" ? "inspected or revealed" : "changed or deleted";
  return `${name} is provisioned and owned by Cadet Cloud. It cannot be ${verb} through the credentials API.`;
}
