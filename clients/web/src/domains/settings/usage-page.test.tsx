/**
 * The settings usage page is a plain page: the tab content renders directly —
 * no billing sub-tab, no billing hand-off links. Billing management lives on
 * the cloud's account pages now.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import { UsagePage } from "@/domains/settings/usage-page";
import * as activeAssistantIdModule from "@/assistant/use-active-assistant-id";

// The usage content reads the active assistant, which normally comes from
// the route gate this test does not mount.
mock.module("@/assistant/use-active-assistant-id", () => ({
  ...activeAssistantIdModule,
  useActiveAssistantId: () => "assistant-1",
}));

mock.module("@/domains/settings/usage/usage-tab", () => ({
  UsageTab: () => <div data-testid="usage-tab-stub" />,
}));

describe("usage-page", () => {
  afterEach(cleanup);

  test("renders the usage content plain — no tabs, no billing links", () => {
    render(
      <MemoryRouter>
        <UsagePage />
      </MemoryRouter>,
    );

    expect(screen.getByTestId("usage-tab-stub")).toBeDefined();
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(
      screen
        .queryAllByRole("link")
        .filter((link) => link.getAttribute("href")?.includes("/account/")),
    ).toHaveLength(0);
  });
});
