/**
 * The environment brand: each Cadet environment's chrome wears the ground
 * color its platform icon builds wear (see the desktop icon READMEs' sRGB
 * table), while production keeps the full gradient mark. The serving
 * deployment declares which environment it is via DOCS_BRAND_ENV — the
 * app never sniffs hostnames. `test` has no icon-family precedent yet;
 * it borrows the design library's info blue.
 */
export const ENVIRONMENT_GROUNDS = {
  production: "#4C9B50",
  staging: "#E9C91A",
  test: "#467CC8",
  dev: "#FF88C9",
  local: "#0E9B8B",
} as const;

export type BrandEnvironment = keyof typeof ENVIRONMENT_GROUNDS;

export function brandEnvironment(): BrandEnvironment {
  const env = process.env.DOCS_BRAND_ENV;
  return env === "staging" || env === "test" || env === "dev" || env === "local"
    ? env
    : "production";
}

/** The nav/footer mark at the given size slot; production drops the suffix. */
export function logoSrc(
  mark: "mycadet-logo" | "cadet-logo",
  env: BrandEnvironment = brandEnvironment(),
): string {
  return `/docs/${mark}${env === "production" ? "" : `-${env}`}.svg`;
}
