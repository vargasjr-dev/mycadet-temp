/** Apex domain that redirects to the canonical www host. */
export const APEX_DOMAIN = "mycadet.ai";

/** Canonical marketing site domain. */
export const WWW_DOMAIN = "www.mycadet.ai";

/** True when `host` is `domain` itself or any subdomain of it. */
export function hostMatchesDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}
