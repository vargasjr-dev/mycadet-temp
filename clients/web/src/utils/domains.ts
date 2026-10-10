/** Apex domain that redirects to the canonical www host. */
export const APEX_DOMAIN = "mycadet.ai";

/** Canonical marketing site domain. */
export const WWW_DOMAIN = "www.mycadet.ai";

/** The eTLD+1 shared by all Cadet domains. Cookie domain uses a leading dot. */
export const CADET_COOKIE_DOMAIN = ".mycadet.ai";

/**
 * Hostnames where the assistant is cloud-hosted (not local daemon).
 * Used to detect cloud-hosted mode for assistant lifecycle management.
 */
export const PLATFORM_HOSTED_HOSTNAMES: readonly string[] = [
  WWW_DOMAIN,
  APEX_DOMAIN,
];

/** True when `host` is `domain` itself or any subdomain of it. */
export function hostMatchesDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/** Check if a hostname belongs to the mycadet.ai domain family. */
export function isCadetDomain(host: string): boolean {
  return hostMatchesDomain(host, APEX_DOMAIN);
}
