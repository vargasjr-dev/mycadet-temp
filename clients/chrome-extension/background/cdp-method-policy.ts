/**
 * Last-mile policy for CDP commands the extension will send through
 * chrome.debugger. Unknown methods and missing tab bindings fail closed
 * here even if the daemon asked for them.
 */

/** Explicit opt-in to the focused tab. Must match the daemon sentinel. */
export const ACTIVE_TAB_SESSION_ID = "active";

const CADET_WITHOUT_TARGET = new Set([
  "Cadet.createTab",
  "Cadet.findTab",
  "Cadet.listTabs",
  "Cadet.selectTab",
  "Cadet.closeTab",
]);

const CADET_WITH_TARGET = new Set(["Cadet.attach", "Cadet.detach"]);

const ALLOWED_PREFIXES = [
  "Page.",
  "Runtime.",
  "DOM.",
  "Input.",
  "Accessibility.",
] as const;

const ALLOWED_NETWORK = new Set([
  "Network.enable",
  "Network.disable",
  "Network.getAllCookies",
  "Network.getResponseBody",
]);

export function isAllowedCdpMethod(method: string): boolean {
  if (CADET_WITHOUT_TARGET.has(method) || CADET_WITH_TARGET.has(method)) {
    return true;
  }
  if (ALLOWED_NETWORK.has(method)) {
    return true;
  }
  return ALLOWED_PREFIXES.some((prefix) => method.startsWith(prefix));
}

export function commandRequiresTabBinding(method: string): boolean {
  if (CADET_WITHOUT_TARGET.has(method)) {
    return false;
  }
  return isAllowedCdpMethod(method);
}

export function tabBindingError(
  method: string,
  cdpSessionId: string | undefined,
): string | undefined {
  if (!commandRequiresTabBinding(method)) {
    return undefined;
  }
  if (cdpSessionId == null || cdpSessionId.trim() === "") {
    return "cdpSessionId (tab binding) is required";
  }
  return undefined;
}
