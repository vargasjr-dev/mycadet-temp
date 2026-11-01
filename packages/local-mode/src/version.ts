/**
 * Strip an optional leading `v`/`V` prefix: "v0.7.0" → "0.7.0".
 */
export function stripVersionPrefix(version: string): string {
  return version.replace(/^[vV]/, "");
}
