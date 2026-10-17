import { getIsCloud, getIsContainerized } from "../config/env-registry.js";
import type { ToolContext } from "../tools/types.js";

export function isVirtualDesktopCloud(
  containerized: boolean = getIsContainerized(),
  cloudHosted: boolean = getIsCloud(),
): boolean {
  return cloudHosted && containerized;
}

/** Gates desktop streaming and control to enabled, cloud-hosted containers. */
export function isVirtualDesktopEnabled(
  containerized: boolean = getIsContainerized(),
  cloudHosted: boolean = getIsCloud(),
): boolean {
  return isVirtualDesktopCloud(containerized, cloudHosted);
}

export function canUseVirtualDesktop(
  context: Pick<ToolContext, "trustClass" | "sourceActorPrincipalId">,
  enabled: boolean = isVirtualDesktopEnabled(),
): boolean {
  return (
    context.trustClass === "guardian" &&
    !!context.sourceActorPrincipalId &&
    enabled
  );
}

/** Web browser turns default to the streamed desktop; native apps keep their host. */
export function shouldUseVirtualDesktop(
  context: Pick<
    ToolContext,
    "transportInterface" | "clientOs" | "trustClass" | "sourceActorPrincipalId"
  >,
  enabled: boolean = isVirtualDesktopEnabled(),
): boolean {
  return (
    context.transportInterface === "web" &&
    context.clientOs !== "macos" &&
    context.clientOs !== "windows" &&
    context.clientOs !== "linux" &&
    canUseVirtualDesktop(context, enabled)
  );
}

export function supportsVirtualDesktopComputerUse(toolName: string): boolean {
  return [
    "computer_use_observe",
    "computer_use_click",
    "computer_use_type_text",
    "computer_use_key",
    "computer_use_scroll",
    "computer_use_drag",
    "computer_use_wait",
    "computer_use_sequence",
    "computer_use_done",
    "computer_use_respond",
  ].includes(toolName);
}
