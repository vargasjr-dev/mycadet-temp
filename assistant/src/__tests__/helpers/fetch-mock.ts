/**
 * Bun's `fetch` type carries a `preconnect` static the plain call mocks
 * lack; graft the no-op static so the mock assigns to the global without a
 * cast.
 */
export function fetchMock<T extends (...args: never[]) => unknown>(
  m: T,
): T & { preconnect: (url: string | URL) => void } {
  return Object.assign(m, { preconnect: () => {} });
}
