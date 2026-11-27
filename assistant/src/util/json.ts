import { isPlainObject } from "./object.js";
/**
 * Parse JSON without throwing — returns null on failure.
 */
export function parseJsonSafe<T = unknown>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** Convert any object's Date-valued fields to ISO strings. */
export function datesToISO<T extends Record<string, unknown>>(
  obj: T,
): { [K in keyof T]: T[K] extends Date ? string : T[K] } {
  const result: Record<string, unknown> = { ...obj };
  for (const [key, value] of Object.entries(result)) {
    if (value instanceof Date) {
      result[key] = value.toISOString();
    }
  }
  return result as { [K in keyof T]: T[K] extends Date ? string : T[K] };
}

/** Parse a JSON object, rejecting other JSON values. */
export function parseJsonRecord(raw: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw);
  if (!isPlainObject(parsed)) {
    throw new SyntaxError("Expected a JSON object");
  }
  return parsed;
}

/** Tolerant JSON parse that returns `{}` for invalid or non-object payloads. */
export function safeParseRecord(raw: string): Record<string, unknown> {
  try {
    return parseJsonRecord(raw);
  } catch {
    return {};
  }
}
