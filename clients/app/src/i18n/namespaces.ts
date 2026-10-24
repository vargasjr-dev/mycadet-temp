/** App-owned translation catalogs: account screens and shared app copy. */
export const NAMESPACES = [
  "common",
  "account",
  "consent",
  "onboarding",
] as const;
export type Namespace = (typeof NAMESPACES)[number];
export const DEFAULT_NAMESPACE = "common";
