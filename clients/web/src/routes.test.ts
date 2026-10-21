import { remoteGatewayPublicPathPrefix } from "@/lib/auth/remote-gateway-session";
import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { matchRoutes } from "react-router";

mock.module("@/generated/gateway/@tanstack/react-query.gen", () => ({
  assistantFeatureFlagsGetOptions: () => ({ queryKey: ["assistant-flags"] }),
  assistantFeatureFlagsGetQueryKey: () => ["assistant-flags"],
}));

const originalWarn = console.warn;
console.warn = (...args: Parameters<typeof console.warn>) => {
  if (
    typeof args[0] === "string" &&
    args[0].includes("KaTeX doesn't work in quirks mode")
  ) {
    return;
  }
  originalWarn(...args);
};

const { routeTree } = await import("@/routes");
const { authMiddleware } = await import("@/lib/auth/auth-middleware");
const { onboardingCompletedMiddleware } =
  await import("@/lib/onboarding-middleware");

afterAll(() => {
  console.warn = originalWarn;
});

afterEach(() => {
  window.__CADET_CONFIG__ = undefined;
  window.history.pushState(null, "", "/");
});

// Walk the matched route chain for `path` and report whether the component
// named `name` is one of its layout components. Matching runs against the raw
// `routeTree` (not the constructed `router`) because `createBrowserRouter`
// consumes the `Component` field, leaving nothing to inspect.
function isUnderComponent(path: string, name: string): boolean {
  const matches = matchRoutes(routeTree as never, path) ?? [];
  return matches.some(
    (m) =>
      (m.route as { Component?: { name?: string } }).Component?.name === name,
  );
}

function hasRouteMiddleware(path: string, basename?: string): boolean {
  const matches = matchRoutes(routeTree as never, path, basename) ?? [];
  return matches.some((m) =>
    Array.isArray((m.route as { middleware?: unknown }).middleware),
  );
}

// React Router runs middleware from the outermost matched route inward, and in
// array order within each route, so flattening the matched chain that way is
// the order they run in.
function middlewareExecutionOrder(path: string): unknown[] {
  const matches = matchRoutes(routeTree as never, path) ?? [];
  return matches.flatMap(
    (m) => (m.route as { middleware?: unknown[] }).middleware ?? [],
  );
}

function leafRouteComponentName(path: string): string | undefined {
  const matches = matchRoutes(routeTree as never, path) ?? [];
  const leaf = matches.at(-1)?.route as
    | { Component?: { name?: string } }
    | undefined;
  return leaf?.Component?.name;
}

describe("nuked account pages", () => {
  // The account pages this bundle used to own are deleted (their maintained
  // ports live in the app bundle) and NOTHING redirects their old paths —
  // all surfaces are committing to the app shell bundle, so a stray visit
  // falls through to the NotFound splat. The exits were rewired off
  // `/account/login` to the remote-web pairing page in the same change, and
  // the chooser's standalone mount left with the screen's deletion — the
  // app bundle's chooser answers that path at the hub level.
  test.each([
    "/account",
    "/account/login",
    "/account/signup",
    "/account/select-assistant",
    "/account/provider/callback",
    "/account/provider/signup",
    "/account/oauth/complete",
    "/account/oauth/popup-complete",
    "/account/oauth/desktop-complete",
    "/account/cloud-callback",
    "/logout",
  ])("%s falls through to the NotFound splat", (path) => {
    const matches = matchRoutes(routeTree as never, path) ?? [];
    expect(matches.at(-1)?.route.path).toBe("*");
  });
});

describe("remote web pairing route", () => {
  test("stays outside the auth-protected assistant app tree", () => {
    expect(hasRouteMiddleware("/assistant/pair?deviceCode=abc")).toBe(false);
  });

  test("uses the remote-gateway public path prefix as the router basename", () => {
    window.__CADET_CONFIG__ = { remote: "docker" };
    window.history.pushState(
      null,
      "",
      "/assistant-123/assistant/pair?deviceCode=abc",
    );

    expect(remoteGatewayPublicPathPrefix()).toBe("/assistant-123");
    expect(
      hasRouteMiddleware(
        "/assistant-123/assistant/pair?deviceCode=abc",
        "/assistant-123",
      ),
    ).toBe(false);
  });

  test("uses the cloud artifact's versioned path as the router basename", () => {
    // Cloud bundles load from /web/<version>/assistant/… — the gateway's
    // artifact surface, proxied 1:1 by the platform host. The prefix is
    // where the bundle was loaded from (a topology fact), not an auth
    // question, so it strips exactly like the remote-gateway prefix does.
    // Without it the router matched the full iframe path, found no /web
    // route, and /assistant rendered the not-found catch-all.
    window.__CADET_CONFIG__ = { remote: "cloud" };
    window.history.pushState(null, "", "/web/2026.10.14-1/assistant/");

    expect(remoteGatewayPublicPathPrefix()).toBe("/web/2026.10.14-1");
  });
});

describe("credential entry route", () => {
  // The one-time credential entry page must stay outside the auth-protected
  // assistant app tree: the link recipient may have no Cadet session, and
  // the single-use token in the request body is the only authorization.
  test("matches outside the auth-protected assistant app tree", () => {
    const matches =
      matchRoutes(routeTree as never, "/assistant/credentials/enter") ?? [];
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.at(-1)?.pathname).toBe("/assistant/credentials/enter");
    expect(hasRouteMiddleware("/assistant/credentials/enter?token=abc")).toBe(
      false,
    );
  });

  test("matches under the remote-gateway public path prefix basename", () => {
    window.__CADET_CONFIG__ = { remote: "docker" };
    window.history.pushState(
      null,
      "",
      "/assistant-123/assistant/credentials/enter",
    );

    expect(remoteGatewayPublicPathPrefix()).toBe("/assistant-123");
    expect(
      hasRouteMiddleware(
        "/assistant-123/assistant/credentials/enter",
        "/assistant-123",
      ),
    ).toBe(false);
  });
});

describe("schedules routes", () => {
  // The Schedules page and per-schedule deep links render the same lazy
  // SchedulesPage (under IntelligenceLayout), inside the auth-protected
  // assistant tree.
  test.each(["/assistant/schedules", "/assistant/schedules/sch_123"])(
    "%s matches inside the auth-protected app tree",
    (path) => {
      const matches = matchRoutes(routeTree as never, path) ?? [];
      expect(matches.length).toBeGreaterThan(0);
      expect(matches.at(-1)?.pathname).toBe(path);
      expect(hasRouteMiddleware(path)).toBe(true);
    },
  );

  test("captures the schedule id as a route param", () => {
    const matches =
      matchRoutes(routeTree as never, "/assistant/schedules/sch_123") ?? [];
    expect(matches.at(-1)?.params.scheduleId).toBe("sch_123");
  });
});

describe("app viewer route", () => {
  const appPath = "/assistant/conversations/c1/app/app-1";

  test("renders the chat page", () => {
    expect(leafRouteComponentName(appPath)).toBe("ChatPage");
  });

  test("captures the conversation and app ids as route params", () => {
    const matches = matchRoutes(routeTree as never, appPath) ?? [];
    expect(matches.at(-1)?.params).toEqual({
      conversationId: "c1",
      appId: "app-1",
    });
  });

  // ChatPage owns its own lifecycle UI and must render in every assistant
  // state, so the app sub-route sits beside the conversation route rather
  // than under the gate.
  test("stays outside ActiveAssistantGate and inside ChatLayoutRoute", () => {
    expect(isUnderComponent(appPath, "ActiveAssistantGate")).toBe(false);
    expect(isUnderComponent(appPath, "ChatLayoutRoute")).toBe(true);
  });
});

describe("skills routes", () => {
  test("captures the skill id as a route param", () => {
    const matches =
      matchRoutes(routeTree as never, "/assistant/skills/my-skill") ?? [];
    expect(matches.at(-1)?.params.skillId).toBe("my-skill");
  });

  // Round-trip for namespaced skills.sh catalog ids (`org/repo/skill`):
  // `routes.skills.detail` percent-encodes the id into a single path segment
  // so `skills/:skillId` matches, and React Router decodes the param back to
  // the raw id — the detail page must NOT decode again.
  test("round-trips slash-containing skill ids through detail URLs", async () => {
    const { routes } = await import("@/utils/routes");
    const url = routes.skills.detail("org/repo/shared-skill");
    expect(url).toBe("/assistant/skills/org%2Frepo%2Fshared-skill");

    const matches = matchRoutes(routeTree as never, url) ?? [];
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.at(-1)?.params.skillId).toBe("org/repo/shared-skill");
  });
});

describe("onboarding funnel middleware order", () => {
  // A paid return reaches the hatching route with its funnel markers in the
  // query string, and an unconsented user is bounced from there to the privacy
  // screen. `authMiddleware` resolves the guard with `pathname + search`, so
  // its bounce carries the markers along as `returnTo`;
  // `onboardingCompletedMiddleware` resolves with `pathname` alone and bounces
  // without them. Running the auth guard first is what keeps the markers, so a
  // reshuffle that puts the onboarding guard in front silently finishes the
  // hatch at the baseline plan.
  test("runs the auth guard before the onboarding guard on the hatching route", () => {
    const order = middlewareExecutionOrder(
      "/assistant/onboarding/hatching?hosting=cadet-cloud&post_checkout=1",
    );
    const authIndex = order.indexOf(authMiddleware);
    const onboardingIndex = order.indexOf(onboardingCompletedMiddleware);

    expect(authIndex).toBeGreaterThanOrEqual(0);
    expect(onboardingIndex).toBeGreaterThanOrEqual(0);
    expect(authIndex).toBeLessThan(onboardingIndex);
  });

  // The paid return lands here on web and Electron. Its markers survive the
  // consent bounce because `authMiddleware` — which resolves with pathname +
  // search — is the only guard on the route. Moving it under the onboarding
  // guard, which resolves with the pathname alone, would drop them and finish
  // the hatch at the baseline plan.
  test("guards the research funnel route with the auth middleware alone", () => {
    const order = middlewareExecutionOrder(
      "/assistant/onboarding/research?hosting=cadet-cloud&post_checkout=1",
    );

    expect(order).toContain(authMiddleware);
    expect(order).not.toContain(onboardingCompletedMiddleware);
  });
});

describe("settings route compatibility", () => {
  test("legacy MCP settings URL redirects to the Integrations MCP tab", () => {
    expect(leafRouteComponentName("/assistant/settings/mcp")).toBe(
      "McpSettingsRedirect",
    );
  });

  test("legacy Advanced settings URL redirects to Debug", () => {
    expect(leafRouteComponentName("/assistant/settings/advanced")).toBe(
      "AdvancedSettingsRedirect",
    );
  });

  test("the Debug settings URL renders the page rather than redirecting", () => {
    const matches = matchRoutes(
      routeTree as never,
      "/assistant/settings/debug",
    );
    const leaf = matches?.at(-1)?.route as
      | { lazy?: unknown; Component?: { name?: string } }
      | undefined;
    // `lazy` is the page itself; a redirect route would carry a named
    // `Component` instead.
    expect(leaf?.lazy).toBeDefined();
    expect(leaf?.Component).toBeUndefined();
  });
});

describe("Activity route compatibility", () => {
  // Bookmarks, saved deep links, and the login `returnTo` round-trip all still
  // name `/assistant/home`. Reaching the catch-all is the failure this guards:
  // the URL has to resolve to something that forwards.
  test("the legacy Activity URL matches a route rather than the catch-all", async () => {
    const matches = matchRoutes(routeTree as never, "/assistant/home") ?? [];
    const leaf = matches.at(-1)?.route as
      | {
          lazy?: { Component: () => Promise<unknown> };
          Component?: { name?: string };
        }
      | undefined;

    expect(leaf?.Component?.name).not.toBe("NotFound");
    expect(await leaf?.lazy?.Component()).toBe(
      (await import("@/domains/home/activity-redirect-page"))
        .ActivityRedirectPage,
    );
  });
});

describe("Settings route prefetching", () => {
  // What `prefetchRoute` warms is every `lazy` on the matched branch, so the
  // number of lazy properties on this branch is the number of round trips a
  // cold tap on Settings pays before the router will commit. The layout and
  // its index page are separate chunks, and warming the root has to cover
  // both: warming only the layout would still leave the page to fetch on tap.
  test("the Settings root carries the layout chunk and its index page chunk", async () => {
    const matches =
      matchRoutes(routeTree as never, "/assistant/settings") ?? [];
    const lazyRoutes = matches.filter(
      (m) => (m.route as { lazy?: unknown }).lazy !== undefined,
    );

    expect(lazyRoutes).toHaveLength(2);

    const loaded = await Promise.all(
      lazyRoutes.map(async (m) =>
        (
          m.route as { lazy: { Component: () => Promise<unknown> } }
        ).lazy.Component(),
      ),
    );
    expect(loaded).toContain(
      (await import("@/domains/settings/settings-layout")).SettingsLayout,
    );
    expect(loaded).toContain(
      (await import("@/domains/settings/pages/general-page")).GeneralPage,
    );
  });
});
