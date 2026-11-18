/**
 * The repo's one fetch-emulation type. `typeof fetch` is NOT portable here:
 * bun-types' fetch carries a required `preconnect` property (production
 * injectables like Electron's `net.fetch` don't have it), and the bearer /
 * forward seams narrow the input to a string (URLs are always resolved by
 * the caller). Every injectable fetch stand-in and fetcher parameter takes
 * THIS type.
 */
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** The methods the operator surface speaks — route rows and requests both. */
export type HTTPMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "HEAD"
  | "OPTIONS";
