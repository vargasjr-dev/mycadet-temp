/**
 * Parent-frame navigation bridge for remote-gateway mode.
 *
 * The bundle boots inside an iframe on the platform's origin while the
 * router owns the iframe's history. Neither side can observe the other's
 * history directly, so both directions travel over postMessage:
 *
 *   - iframe -> parent: history.pushState/replaceState fire no event a
 *     parent frame can observe, so the wrappers below postMessage every
 *     internal navigation out as `{ source: "mycadet-web-nav", nav, path }`.
 *     The parent mirrors the path into the browser URL so deep links and
 *     hard reloads land on the same screen.
 *   - parent -> iframe: the parent postMessages `{ source:
 *     "mycadet-web-parent-nav", path }` on its own popstate; applying it via
 *     replaceState + a synthetic popstate re-resolves the router without a
 *     reload. The applied navigation is suppressed on the outbound side so
 *     it never echoes back and grows the parent's history.
 */
import { isRemoteGatewayMode } from "@/lib/local-mode";

const NAV_SOURCE = "mycadet-web-nav";
const PARENT_NAV_SOURCE = "mycadet-web-parent-nav";

let applyingParentNav = false;

function currentPath(): string {
  return (
    window.location.pathname + window.location.search + window.location.hash
  );
}

function emitToParent(nav: "push" | "replace" | "pop"): void {
  if (applyingParentNav) return;
  try {
    window.parent.postMessage(
      { source: NAV_SOURCE, nav, path: currentPath() },
      "*",
    );
  } catch {
    // A dead or denied parent must never break in-iframe navigation.
  }
}

export function setupRemoteGatewayNavBridge(): void {
  if (!isRemoteGatewayMode()) return;

  for (const method of ["pushState", "replaceState"] as const) {
    const original = window.history[method].bind(window.history);
    window.history[method] = ((
      data: unknown,
      unused: string,
      url?: string | URL | null,
    ) => {
      const result = original(data, unused, url);
      emitToParent(method === "pushState" ? "push" : "replace");
      return result;
    }) as History["pushState"];
  }

  window.addEventListener("popstate", () => emitToParent("pop"));
  window.addEventListener("hashchange", () => emitToParent("pop"));

  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window.parent) return;
    const data = event.data as { source?: string; path?: unknown } | null;
    if (!data || data.source !== PARENT_NAV_SOURCE) return;
    if (typeof data.path !== "string" || !data.path.startsWith("/")) return;
    if (data.path === currentPath()) return;

    applyingParentNav = true;
    try {
      // Preserve history.state (the router's internal index bookkeeping) or
      // back/forward depth corrupts.
      window.history.replaceState(window.history.state, "", data.path);
      window.dispatchEvent(new PopStateEvent("popstate"));
    } finally {
      applyingParentNav = false;
    }
  });
}
