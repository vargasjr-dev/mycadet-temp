/**
 * Tests for `CreditsUpsellCard`, the in-transcript credit wall that resolves
 * its own CTA mode from the plan and opens the shared Add Credits modal store
 * (the modal mount itself is covered in `lazy-add-credits-modal.test.tsx`).
 *
 * The mode inputs are mocked at the hook seam (`useIsFreePlan`,
 * `useCloudGate`) and toggled per-test: `mock.module` is process-global, so
 * a second registration would leak into the rest of the file. `useNavigate` is
 * mocked so the View-plans wiring can be asserted without a Router, and
 * `CloudLoginNotice` is stubbed (its login flow needs a Router + auth
 * context).
 */
import type { ReactNode } from "react";
import * as reactRouter from "react-router";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { cloudAccountBillingUrl } from "@/lib/cloud-runtime-url";
import * as cloudGateModule from "@/hooks/use-cloud-gate";
import { stubModule } from "@/utils/module-mock.test-helper";
import type { CloudGateState } from "@/hooks/use-cloud-gate";
import { useAddCreditsModalStore } from "@/stores/add-credits-modal-store";

const openExternalUrlMock = mock(async (_url: string) => undefined);
stubModule("@/runtime/browser", await import("@/runtime/browser"), {
  openExternalUrl: openExternalUrlMock,
});

let navigateTargets: unknown[] = [];
mock.module("react-router", () => ({
  ...reactRouter,
  useNavigate: () => (to: unknown) => {
    navigateTargets.push(to);
  },
}));

let isFreePlan: boolean | undefined = true;
let freePlanEnabledArgs: unknown[] = [];
mock.module("@/hooks/use-is-free-plan", () => ({
  useIsFreePlan: (enabled?: boolean) => {
    freePlanEnabledArgs.push(enabled);
    return isFreePlan;
  },
}));

let cloudGate: CloudGateState = "full";
mock.module("@/hooks/use-cloud-gate", () => ({
  ...cloudGateModule,
  useCloudGate: () => cloudGate,
}));

mock.module("@/components/cloud-login-notice", () => ({
  CloudLoginNotice: ({ children }: { children: ReactNode }) => (
    <div data-testid="cloud-login-notice-stub">{children}</div>
  ),
}));

import { CreditsUpsellCard } from "./credits-upsell-card";

beforeEach(() => {
  navigateTargets = [];
  isFreePlan = true;
  freePlanEnabledArgs = [];
  cloudGate = "full";
  useAddCreditsModalStore.setState({ open: false });
});

afterEach(() => {
  cleanup();
});

describe("CreditsUpsellCard", () => {
  test("free plan renders the Upgrade CTA and hands off to the cloud's billing page", () => {
    const { getByRole, getByText } = render(<CreditsUpsellCard />);

    expect(getByText("You’re out of Free credits")).toBeTruthy();
    expect(
      getByText("Upgrade your plan to keep the conversation going."),
    ).toBeTruthy();

    fireEvent.click(getByRole("button", { name: "Upgrade" }));
    expect(openExternalUrlMock).toHaveBeenCalledWith(cloudAccountBillingUrl());
    expect(useAddCreditsModalStore.getState().open).toBe(false);
  });

  test("paid plan renders the Add credits CTA and opens the shared modal store", () => {
    isFreePlan = false;

    const { getByRole, getByText, queryByRole } = render(<CreditsUpsellCard />);

    expect(getByText("You’re out of credits")).toBeTruthy();
    expect(
      getByText("Add credits to pick up where you left off."),
    ).toBeTruthy();
    expect(queryByRole("button", { name: "Upgrade" })).toBeNull();

    fireEvent.click(getByRole("button", { name: "Add credits" }));
    expect(useAddCreditsModalStore.getState().open).toBe(true);
    expect(navigateTargets).toEqual([]);
  });

  test("unresolved plan renders the Add credits CTA", () => {
    isFreePlan = undefined;

    const { getByRole, getByText, queryByRole } = render(<CreditsUpsellCard />);

    expect(getByText("You’re out of credits")).toBeTruthy();
    expect(queryByRole("button", { name: "Upgrade" })).toBeNull();

    fireEvent.click(getByRole("button", { name: "Add credits" }));
    expect(useAddCreditsModalStore.getState().open).toBe(true);
    expect(navigateTargets).toEqual([]);
  });

  test("renders the leading credits icon", () => {
    const { getByText } = render(<CreditsUpsellCard />);
    expect(getByText("💰")).toBeTruthy();
  });

  test("full gate enables the subscription fetch behind useIsFreePlan", () => {
    render(<CreditsUpsellCard />);
    expect(freePlanEnabledArgs).toEqual([true]);
  });

  test("disabled gate renders the login treatment instead of a billing CTA", () => {
    cloudGate = "disabled";

    const { getByTestId, getByText, queryByRole } = render(
      <CreditsUpsellCard />,
    );

    expect(getByTestId("cloud-login-notice-stub")).toBeTruthy();
    expect(getByText("Log in to Cadet Cloud to add credits.")).toBeTruthy();
    expect(queryByRole("button", { name: "Add credits" })).toBeNull();
    expect(queryByRole("button", { name: "Upgrade" })).toBeNull();
    // No platform session means the subscription request would go out
    // unauthenticated; the gate must keep the fetch disabled.
    expect(freePlanEnabledArgs).toEqual([false]);
  });

  test("gated (self-hosted assistant) renders nothing", () => {
    cloudGate = "gated";

    const { container } = render(<CreditsUpsellCard />);

    expect(container.innerHTML).toBe("");
    expect(freePlanEnabledArgs).toEqual([false]);
  });
});
