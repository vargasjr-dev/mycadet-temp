import {
  CADET_ENVIRONMENT_NAMES,
  type CadetEnvironment,
} from "@mycadet/shared/seeds";

/**
 * Each environment's chrome wears the ground color its platform icon
 * build wears (see the desktop icon READMEs' sRGB table); production
 * keeps the full gradient mark. The serving deployment declares which
 * environment it is via the shared `CADET_ENVIRONMENT` var — the app
 * never sniffs hostnames.
 */
export const ENVIRONMENT_GROUNDS: Record<CadetEnvironment, string> = {
  production: "#4C9B50",
  staging: "#E9C91A",
  test: "#467CC8",
  dev: "#FF88C9",
  local: "#0E9B8B",
};

export function brandEnvironment(): CadetEnvironment {
  const named = process.env.CADET_ENVIRONMENT?.trim();
  return CADET_ENVIRONMENT_NAMES.find((name) => name === named) ?? "production";
}

export function logoSrc(env: CadetEnvironment = brandEnvironment()): string {
  return `/docs/cadet-logo${env === "production" ? "" : `-${env}`}.svg`;
}
