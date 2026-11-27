/** Attach Bun's fetch static to a test double without changing its call type. */
export function fetchMock<T extends (...args: never[]) => unknown>(
  handler: T,
): T & Pick<typeof fetch, "preconnect"> {
  return Object.assign(handler, { preconnect: () => {} });
}
