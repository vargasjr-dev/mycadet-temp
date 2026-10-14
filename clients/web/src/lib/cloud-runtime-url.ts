import { cloudAssistantHubUrl } from "@mycadet/environments/seeds";
import { readInjectedConfig } from "@/lib/injected-config";

/** Resolve cloud traffic independently of a self-hosted gateway's origin. */
export function getPlatformRuntimeUrl(): string {
  const config = readInjectedConfig();
  if (config.cloudUrl) {
    return config.cloudUrl;
  }
  if (config.remote === "docker" || config.remote === "custom") {
    return new URL(config.hubUrl ?? cloudAssistantHubUrl("production")).origin;
  }
  return window.location.origin;
}
