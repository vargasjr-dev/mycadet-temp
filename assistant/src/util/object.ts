export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

/** Narrow an object for unknown-valued property access, including arrays. */
export function isObjectRecord(
  value: unknown,
): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

/** Read a property on an opaque object without assuming its shape. */
export function getObjectProperty(value: unknown, key: PropertyKey): unknown {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    return undefined;
  }
  if (!hasObjectProperty(value, key)) {
    return undefined;
  }
  return value[key];
}

function hasObjectProperty<K extends PropertyKey>(
  value: object,
  key: K,
): value is Record<K, unknown> {
  return key in value;
}
