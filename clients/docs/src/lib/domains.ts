/** Canonical marketing site domain. Canonical URLs stay on www even though this app serves only /docs. */
export const WWW_DOMAIN = "www.mycadet.ai";
export const WWW_ORIGIN = `https://${WWW_DOMAIN}`;

// The apex (no www) is the brand surface: it hands out the install script
// and the public API. Removing the www later is a one-line edit here.
export const APEX_DOMAIN = "mycadet.ai";
export const APEX_ORIGIN = `https://${APEX_DOMAIN}`;
