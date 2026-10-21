import { readInjectedConfig } from "@/lib/injected-config";
import { SEEDS } from "@mycadet/environments/seeds";

/** An explicit host override wins; otherwise the build environment owns cloud routing. */
export function getCloudRuntimeUrl(): string {
  return (
    readInjectedConfig()?.cloudUrl ??
    (
      SEEDS[import.meta.env.VITE_ENVIRONMENT ?? "production"] ??
      SEEDS.production
    ).cloudUrl
  );
}

/**
 * The cloud's account billing page — subscription and credit management live
 * there now (the web app retired its billing surfaces).
 */
export function cloudAccountBillingUrl(): string {
  return `${getCloudRuntimeUrl()}/account/billing`;
}
