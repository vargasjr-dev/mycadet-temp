/** Synthetic guardian names from current and previously issued principal IDs. */
export function isGeneratedPrincipalName(name: string): boolean {
  return /^(?:cadet-)?principal-/.test(name);
}
