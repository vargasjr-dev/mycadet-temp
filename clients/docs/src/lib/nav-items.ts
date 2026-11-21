export interface NavItem {
  href: string;
  label: string;
  external?: boolean;
}

// The marketing header's link row, shared by the nav (and any mobile menu
// that grows out of it) so the two can never drift. Ported from
// mycadet-cloud; /pricing and /plugins resolve once those pages move over.
export const navItems: NavItem[] = [
  { href: "/downloads", label: "Download" },
  { href: "/pricing", label: "Pricing" },
  { href: "/plugins", label: "Plugins" },
  { href: "/docs", label: "Docs" },
  { href: "https://discord.gg/ZABd9V2zM8", label: "Community", external: true },
];
