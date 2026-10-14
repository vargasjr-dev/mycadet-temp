/** Synthetic guardian names from principal IDs. */
export function isGeneratedPrincipalName(name: string): boolean {
  return /^principal-/.test(name);
}
