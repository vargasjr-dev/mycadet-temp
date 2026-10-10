/**
 * bun-types' global fetch carries a `preconnect` member; these mocks only need
 * the call shape, so hand the assignment a member-complete callable. The SUT
 * never calls `preconnect`.
 */
export function withPreconnect(
  impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): typeof globalThis.fetch {
  return Object.assign(impl, { preconnect: () => {} });
}
