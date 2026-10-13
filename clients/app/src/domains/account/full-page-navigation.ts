export function requiresFullPageNavigation(destination: string): boolean {
  return (
    destination.startsWith("http") ||
    destination.startsWith("/accounts/") ||
    destination.startsWith("/v1/") ||
    destination.startsWith("/_allauth/") ||
    // The bring-your-agent import funnel is a marketing page served by the
    // platform Next.js app, not this SPA — client-side navigation would miss.
    destination.startsWith("/import")
  );
}
