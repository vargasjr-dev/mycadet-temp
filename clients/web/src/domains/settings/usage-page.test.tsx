/**
 * The settings usage page is a plain page: the usage chart and tab content
 * render directly — no billing sub-tab, no billing hand-off links. Billing
 * management lives on the cloud's account pages now.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import { UsagePage } from "@/domains/settings/usage-page";
import * as activeAssistantIdModule from "@/assistant/use-active-assistant-id";
import * as cloudGate from "@/hooks/use-cloud-gate";

mock.module("@/hooks/use-cloud-gate", () => ({
  ...cloudGate,
  useCloudGate: () => "full",
  useActiveAssistantIsCloudHosted: () => true,
  useActiveAssistantLifecycleIsLoading: () => false,
}));

// The usage content reads the active assistant, which normally comes from
// the route gate this test does not mount.
mock.module("@/assistant/use-active-assistant-id", () => ({
  ...activeAssistantIdModule,
  useActiveAssistantId: () => "assistant-1",
}));

mock.module("@/domains/settings/usage/usage-tab", () => ({
  UsageTab: () => <div data-testid="usage-tab-stub" />,
}));
mock.module(
  "@/domains/settings/components/inference-usage/inference-usage-panel",
  () => ({ InferenceUsagePanel: () => <div data-testid="usage-chart-stub" /> }),
);

describe("usage-page", () => {
  afterEach(cleanup);

  test("renders the usage content plain — no tabs, no billing links", () => {
    render(
      <MemoryRouter>
        <UsagePage />
      </MemoryRouter>,
    );

    expect(screen.getByTestId("usage-tab-stub")).toBeDefined();
    expect(screen.getByTestId("usage-chart-stub")).toBeDefined();
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(
      screen
        .queryAllByRole("link")
        .filter((link) => link.getAttribute("href")?.includes("/account/")),
    ).toHaveLength(0);
  });
});
