/** Narrow unknown JSON data to a string-keyed record, without assertions. */
export function isJsonObject(
  value: unknown,
): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
