/** Verify that a DOM query returned the element a test intends to exercise. */
export function requireElement<T extends Element>(
  element: Element | null | undefined,
  constructor: abstract new (...args: never[]) => T,
): T {
  if (!(element instanceof constructor)) {
    throw new TypeError(
      `Expected ${constructor.name}, got ${element?.tagName ?? "no element"}`,
    );
  }
  return element;
}
