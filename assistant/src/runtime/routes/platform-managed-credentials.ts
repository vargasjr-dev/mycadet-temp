/**
 * The credential Cadet Cloud provisions onto a managed assistant pod for
 * its own use: the API key the daemon authenticates to the managed LLM proxy
 * with.
 *
 * The platform writes it over `POST /v1/secrets`, and the daemon, the
 * gateway, and CES read it straight out of the vault. The user never sets it
 * through the credentials API and can do nothing useful with it there, so
 * that API treats it as neither readable nor writable: omitted from listings,
 * and refused by inspect, reveal, set, and delete, whatever the calling
 * principal.
 *
 * The key spends inference on Cadet's account; the host it is sent to
 * resolves from config or the `CADET_PLATFORM_URL` environment variable, so
 * there is no stored URL credential to guard alongside it.
 */
// The platform pushes the pre-rebrand display name ("cadet:*"); the
// canonical storage service is "cadet".
const MANAGED_PROXY_CREDENTIALS = [
  { service: "cadet", field: "assistant_api_key" },
] as const;

export function isPlatformManagedCredential(
  service: string,
  field: string,
): boolean {
  return MANAGED_PROXY_CREDENTIALS.some(
    (c) => c.service === service && c.field === field,
  );
}

/** What a caller was trying to do with a platform-managed credential. */
export type PlatformManagedCredentialAction = "read" | "change";

/** Message the credentials API refuses one of these with. */
export function platformManagedCredentialRefusal(
  service: string | undefined,
  field: string | undefined,
  action: PlatformManagedCredentialAction,
): string {
  const name = service && field ? `${service}:${field}` : "This credential";
  const verb =
    action === "read" ? "inspected or revealed" : "changed or deleted";
  return `${name} is provisioned and owned by Cadet Cloud. It cannot be ${verb} through the credentials API.`;
}
