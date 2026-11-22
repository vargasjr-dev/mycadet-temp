/**
 * Tests for the CollapsibleNavSection component.
 *
 * Renders to static markup via `react-dom/server` and asserts on the
 * emitted HTML. Sections do not fold: there is no chevron, no trigger,
 * and no collapsed state to test — the tests below pin the fold's absence
 * as much as the header's own behavior.
 */

import { describe, expect, test } from "bun:test";
import { Clock } from "lucide-react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SIDE_MENU_TILE_SIZE } from "@mycadet/design-library";

import {
  SIDEBAR_SECTION_CONTENT_PADDING_TOP,
  SIDEBAR_SECTION_TITLE_GAP,
  SIDEBAR_SECTION_TITLE_LINE_HEIGHT,
} from "@/components/sidebar-nav-geometry";

import { CollapsibleNavSection } from "./collapsible-nav-section";

function renderSingleSection(opts: {
  label: string;
  trailing?: string;
  card?: boolean;
}) {
  return renderToStaticMarkup(
    createElement(
      CollapsibleNavSection.Root,
      {},
      createElement(
        CollapsibleNavSection.Section,
        {
          card: opts.card,
          icon: Clock,
          label: opts.label,
          trailing: opts.trailing
            ? createElement("span", null, opts.trailing)
            : undefined,
        },
        createElement("div", null, "child-content"),
      ),
    ),
  );
}

describe("CollapsibleNavSection", () => {
  test("renders the label and the content", () => {
    const html = renderSingleSection({ label: "Recents" });
    expect(html).toContain("Recents");
    expect(html).toContain("child-content");
  });

  test("renders the trailing slot when provided", () => {
    const html = renderSingleSection({ label: "Pinned", trailing: "4" });
    expect(html).toContain("4");
  });

  /* No folding: the header owns no trigger of its own. A button appears only
     when a trailing control (the "…") supplies one. */
  test("the header carries no toggle and no chevron", () => {
    const html = renderSingleSection({ label: "Pinned" });
    const buttonCount = (html.match(/<button/g) ?? []).length;
    expect(buttonCount).toBe(0);
    expect(html).not.toContain("lucide-chevron-down");
    expect(html).not.toContain('[data-slot="collapsible-nav-section-chevron"]');
    expect(html).not.toContain("[aria-expanded]");
    expect(html).not.toContain('data-slot="collapsible-indicator"');
    expect(html).not.toContain('data-slot="collapsible-nav-section-indicator"');
  });

  /* The whole point of the fold's removal: the content renders with the
     section, unconditioned by any open state. */
  test("the content is not gated behind an accordion state", () => {
    const html = renderSingleSection({ label: "Recents" });
    expect(html).toContain("child-content");
    expect(html).not.toContain('data-state="closed"');
  });

  test("trailing slot is rendered outside any header button", () => {
    const html = renderToStaticMarkup(
      createElement(
        CollapsibleNavSection.Root,
        {},
        createElement(
          CollapsibleNavSection.Section,
          {
            icon: Clock,
            label: "Pinned",
            trailing: createElement("button", { type: "button" }, "action"),
          },
          null,
        ),
      ),
    );
    const actionButton = html.indexOf("action");
    expect(actionButton).toBeGreaterThanOrEqual(0);
    // The header itself is not a button; the only one is the trailing slot's.
    expect((html.match(/<button/g) ?? []).length).toBe(1);
  });

  test("the header carries the section-title typography utility", () => {
    const html = renderSingleSection({ label: "Recents" });
    expect(html).toContain("text-body-medium-lighter");
  });

  /* Two glyphs used to render here: the caller's leading icon and the
     disclosure chevron. Only the icon remains. */
  test("renders the caller's leading icon and nothing else", () => {
    const html = renderSingleSection({ label: "Recents" });
    const svgCount = (html.match(/<\/svg>/g) ?? []).length;
    expect(svgCount).toBe(1);
    expect(html).toContain("lucide-clock");
  });

  /* The reveal conditions live in one rule in the design library's stylesheet,
     keyed on the hover capability the affordance depends on. What the header
     owes that rule is the scope: the trailing control is revealed by hovering
     anywhere on the header, so the header is the hover scope and the control is
     the affordance inside it. */
  test("the header scopes the reveal of its trailing control", () => {
    const html = renderSingleSection({ label: "Pinned", trailing: "4" });
    const container = document.createElement("div");
    container.innerHTML = html;

    const header = container.querySelector(
      '[data-slot="collapsible-nav-section-header"]',
    );
    expect(header?.hasAttribute("data-reveal-row")).toBe(true);

    const trailing = container.querySelector(
      '[data-slot="collapsible-nav-section-trailing"]',
    );
    expect(trailing?.hasAttribute("data-reveal")).toBe(true);
    /* Inside the scope, not the scope itself: a marker on the header would
       reveal the control whenever the header was hovered by its own hover. */
    expect(trailing?.closest("[data-reveal-row]")).toBe(header);
  });

  test("composes on top of the section shell", () => {
    const html = renderSingleSection({ label: "Recents" });
    expect(html).toContain('data-slot="collapsible-nav-section-section"');
  });
});

/**
 * `sectionIcon` is the single answer to "what does this section look like",
 * and the collapsed rail renders it, so a header must render the same glyph.
 * A header that drops it puts the two surfaces in disagreement while every
 * call site still reads as correct, since the `icon` prop is passed either
 * way.
 */
describe("CollapsibleNavSection icon", () => {
  test("renders the icon the caller passes", () => {
    const html = renderSingleSection({ label: "Scheduled" });
    expect(html).toContain('data-slot="collapsible-nav-section-icon"');
  });

  /* Keeps the assertion above honest: without this, a component that
     emitted the icon slot unconditionally would still pass it. */
  test("renders no icon slot when the section has none", () => {
    const html = renderToStaticMarkup(
      createElement(
        CollapsibleNavSection.Root,
        {},
        createElement(
          CollapsibleNavSection.Section,
          { label: "Scheduled" },
          createElement("div", null, "child-content"),
        ),
      ),
    );
    expect(html).not.toContain('data-slot="collapsible-nav-section-icon"');
  });
});

/**
 * The distance from a section's title to its first row is a sum of two
 * parts kept in different places — the header row's surplus height above
 * and below the title's line box, and the content's own top inset — so
 * each surface is asserted against the shared
 * {@link SIDEBAR_SECTION_TITLE_GAP} rather than against the inset it
 * happens to render. Without this either half can drift on its own and the
 * sections stop agreeing on where their first row sits, which is invisible
 * at each call site because every one of them passes the same props.
 */
describe("CollapsibleNavSection title gap", () => {
  const contentStyle = (html: string) => {
    const content = html.slice(html.indexOf("sidebar-section-list"));
    return /style="([^"]*)"/.exec(content)?.[1] ?? "";
  };

  test("the rail's content adds only what its tile header does not", () => {
    const style = contentStyle(renderSingleSection({ label: "Scheduled" }));
    expect(style).toContain(
      `padding-top:${SIDEBAR_SECTION_CONTENT_PADDING_TOP}px`,
    );
    expect(
      SIDEBAR_SECTION_CONTENT_PADDING_TOP +
        (SIDE_MENU_TILE_SIZE - SIDEBAR_SECTION_TITLE_LINE_HEIGHT) / 2,
    ).toBe(SIDEBAR_SECTION_TITLE_GAP);
  });

  test("a card's header row is the title's line box, so it insets the gap whole", () => {
    const html = renderToStaticMarkup(
      createElement(
        CollapsibleNavSection.Root,
        {},
        createElement(
          CollapsibleNavSection.Section,
          { label: "Scheduled", icon: Clock, card: true },
          createElement("div", null, "child-content"),
        ),
      ),
    );
    expect(contentStyle(html)).toContain(
      `padding-top:${SIDEBAR_SECTION_TITLE_GAP}px`,
    );
  });
});
