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
