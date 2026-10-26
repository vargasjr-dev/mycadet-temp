/**
 * Tests for `PreferencesMenu`.
 *
 * Uses `renderToStaticMarkup` (SSR) so only the trigger and top-level
 * structure are exercisable — Radix Popover/BottomSheet content is not
 * rendered when `open={false}`. Interactive content tests (menu items,
 * navigation) require the DOM renderer below.
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";

import { SideMenu } from "@mycadet/design-library";

import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import {
  restoreStubbedModules,
  stubModule,
} from "@/utils/module-mock.test-helper";
import { routes } from "@/utils/routes";

const isTouchMobileRef = { value: false };

// Every module below is replaced through `stubModule`, which spreads the real
// one and registers the undo `afterAll` runs: `mock.module` is process-global
// in bun, so a partial shape erases a module's other exports for whatever file
// loads it next, and a replacement left standing outlives this file.
afterAll(restoreStubbedModules);

stubModule(
  "@/hooks/use-touch-mobile",
  await import("@/hooks/use-touch-mobile"),
  {
    useTouchMobile: () => isTouchMobileRef.value,
  },
);

stubModule("@/hooks/use-cloud-gate", await import("@/hooks/use-cloud-gate"), {
  useCloudGate: () => "full",
  useActiveAssistantIsCloudHosted: () => true,
});

const authRef: {
  isAuthenticated: boolean;
} = {
  isAuthenticated: true,
};

const authStoreModule = await import("@/stores/auth-store");
// The menu reads two selectors and `getState()`; the rest of the zustand
// surface has no consumer here, so the stub asserts the store's type rather
// than reproducing it.
const authStoreStub = Object.assign(() => null, {
  getState: () => authRef,
}) as unknown as typeof authStoreModule.useAuthStore;
stubModule("@/stores/auth-store", authStoreModule, {
  useAuthStore: authStoreStub,
});
stubModule(
  "@/lib/auth/session-shape",
  await import("@/lib/auth/session-shape"),
  { useIsAuthenticated: () => authRef.isAuthenticated },
);

// Capture navigate() targets so the menu's destinations can be asserted
// without a live Router.
let navigateArgs: unknown[] = [];
stubModule("react-router", await import("react-router"), {
  useNavigate: () => (to: unknown) => {
    navigateArgs.push(to);
  },
});

// The menu owns when the chunk is warmed and when the dialog is mounted; the
// dialog's own lazy wiring is covered by `share-feedback-modal-lazy.test.tsx`.
const feedbackRef = { prefetches: 0 };
stubModule(
  "@/components/share-feedback-modal-lazy",
  await import("@/components/share-feedback-modal-lazy"),
  {
    ShareFeedbackModalLazy: ({ open }: { open: boolean }) =>
      open
        ? createElement("div", { "data-testid": "share-feedback-modal" })
        : createElement(Fragment),
    prefetchShareFeedbackModal: () => {
      feedbackRef.prefetches += 1;
    },
  },
);

// Records the paths the menu warms. Which chunks a path pulls in is
// `prefetch-route.test.ts`'s business; this suite owns only when the menu asks.
const prefetchedPaths: string[] = [];
stubModule("@/lib/prefetch-route", await import("@/lib/prefetch-route"), {
  prefetchRoute: (href?: string) => {
    prefetchedPaths.push(href ?? "");
  },
});

const { PreferencesMenu } =
  await import("@/domains/chat/components/preferences-menu");

/** Opens the menu the way a touch user does. */
async function openMenu(): Promise<void> {
  isTouchMobileRef.value = true;
  render(<PreferencesMenu />);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /Preferences/i }));
    await Promise.resolve();
  });
}

/** Closes the menu through its Settings row, the way a user would. */
async function closeMenuViaSettings(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    await Promise.resolve();
  });
}

beforeEach(() => {
  navigateArgs = [];
  useAssistantIdentityStore.getState().clearIdentity();
  useResolvedAssistantsStore.setState({ activeAssistantId: null });
  isTouchMobileRef.value = false;
  authRef.isAuthenticated = true;
  feedbackRef.prefetches = 0;
  prefetchedPaths.length = 0;
});

afterEach(() => {
  cleanup();
});

describe("PreferencesMenu", () => {
  test("renders nothing when not logged in", () => {
    authRef.isAuthenticated = false;
    const html = renderToStaticMarkup(createElement(PreferencesMenu));
    expect(html).toBe("");
  });

  test("labels the trigger 'Preferences'", () => {
    const html = renderToStaticMarkup(createElement(PreferencesMenu));
    expect(html).toContain("Preferences");
  });

  test("desktop renders trigger (Popover surface)", () => {
    isTouchMobileRef.value = false;
    const html = renderToStaticMarkup(createElement(PreferencesMenu));
    expect(html).toContain("Preferences");
  });

  test("mobile renders trigger (BottomSheet surface)", () => {
    isTouchMobileRef.value = true;
    const html = renderToStaticMarkup(createElement(PreferencesMenu));
    expect(html).toContain("Preferences");
  });

  /* The collapsed rail fits one tile and a pill is sized by its content, so a
     labelled trigger rendered there is clipped mid-word. The tile is not that
     pill with `display:none` on its label: it is a fixed square centring its
     glyph, the same affordance the pinned apps and section tiles reduce to.

     The collapsed `SideMenu` is the whole input: the trigger reads the rail's
     state from that context and takes no prop for it, so this renders the
     component the way the sidebar does and cannot pass a value the menu
     disagrees with. Outside a rail it is an ordinary row, so a bare render
     would assert nothing. */
  function collapsedRailMarkup(): string {
    return renderToStaticMarkup(
      <SideMenu ariaLabel="Assistant navigation" variant="rail" collapsed>
        <SideMenu.Footer>
          <PreferencesMenu />
        </SideMenu.Footer>
      </SideMenu>,
    );
  }

  /** Text a sighted user would read, with every tag and attribute stripped. */
  function visibleText(html: string): string {
    return html.replace(/<[^>]*>/g, "").trim();
  }

  test("collapsed rail drops the label and centers the glyph in a fixed tile", () => {
    const html = collapsedRailMarkup();

    // Fixed square, centered in the rail column, fully rounded - not a
    // content-width capsule that the rail then crops.
    expect(html).toContain("size-[var(--side-menu-tile-size)]");
    expect(html).toContain("mx-auto");
    // Nothing to clip: the label is not rendered at all.
    expect(visibleText(html)).toBe("");
    // ...and the control is still named, for assistive tech and the tooltip.
    expect(html).toContain('aria-label="Preferences"');
  });

  test("collapsed trigger stays a keyboard-reachable menu control", () => {
    const html = collapsedRailMarkup();

    // A real tab stop that announces what it opens. The rail's own
    // `aria-current` is for destinations; this opens a menu over the rail.
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).not.toContain('aria-current="page"');
    expect(html).not.toContain('tabindex="-1"');
  });

  test("expanded rail keeps the labeled pill", () => {
    const html = renderToStaticMarkup(
      <SideMenu ariaLabel="Assistant navigation" variant="rail">
        <SideMenu.Footer>
          <PreferencesMenu />
        </SideMenu.Footer>
      </SideMenu>,
    );

    // The label is visible text here, not just an accessible name, and the
    // trigger is the content-sized pill it shares with the pinned apps.
    expect(visibleText(html)).toContain("Preferences");
    expect(html).toContain("w-fit");
    expect(html).not.toContain("size-[var(--side-menu-tile-size)]");
  });

  // Billing management moved to the cloud's account pages and usage reading
  // to the settings usage page; the popover names neither.
  test("the menu carries no billing or usage entries", async () => {
    await openMenu();

    expect(screen.queryByText(/usage/i)).toBeNull();
    expect(screen.queryByText(/credits/i)).toBeNull();
  });

  test("opening the menu warms the feedback chunk, once", async () => {
    expect(feedbackRef.prefetches).toBe(0);

    await openMenu();
    expect(feedbackRef.prefetches).toBe(1);

    // The menu closes here, which re-renders the component. The chunk is
    // cached after the first fetch, so a second warm buys nothing.
    await closeMenuViaSettings();
    expect(feedbackRef.prefetches).toBe(1);
  });

  test("opening the menu warms the Settings route, once", async () => {
    expect(prefetchedPaths).toEqual([]);

    // GIVEN the menu opens, which is the first moment Settings is a plausible
    // next tap
    await openMenu();

    // THEN its route is warmed, so the two chunks it needs are usually in
    // hand before the tap that navigates to it
    expect(prefetchedPaths).toEqual([routes.settings.root]);

    // AND closing the menu does not ask again
    await closeMenuViaSettings();
    expect(prefetchedPaths).toEqual([routes.settings.root]);
  });

  test("the Settings row navigates to the settings root and closes the menu", async () => {
    await openMenu();

    await closeMenuViaSettings();

    expect(navigateArgs).toEqual([routes.settings.root]);
    // The BottomSheet unmounts its content on close, so the rows are gone.
    expect(screen.queryByRole("button", { name: "Share feedback" })).toBeNull();
  });
});
