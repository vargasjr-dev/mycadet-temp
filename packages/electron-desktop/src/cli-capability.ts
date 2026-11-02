import type { CliInvocation } from "@mycadet/local-mode";

import { capabilityToken } from "./capability-registry";

export interface CliInvocationProvider {
  resolveInvocation: () => Promise<CliInvocation>;
}

/**
 * The host's ability to invoke the cadet CLI as a subprocess. Providers
 * register through the capability registry (Windows resolves the packaged
 * CLI from its installer's runtime layout; macOS and Linux inline their own
 * resolution), and consumers — the bundle host, the host-proxy guardian
 * flow — require it, so provider install order decouples from consumer
 * modules.
 */
export const CLI_INVOCATION = capabilityToken<CliInvocationProvider>(
  "desktop.cli-invocation",
);
