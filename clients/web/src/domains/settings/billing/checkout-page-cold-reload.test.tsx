/**
 * Cold-reload coverage for the deep-link CheckoutPage.
 *
 * `checkout-page.test.tsx` mocks the cloud gate to drive the page's own
 * branches. This file leaves the gate real and drives the auth store instead,
 * so the page sees the window a hard reload of `/assistant/checkout?package=…`
 * actually opens: `sessionStatus` is already authenticated while
 * `cloudSession` is still `"unknown"`, because the local-gateway path
 * settles the first without awaiting the second.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";

import { saveCheckoutIntent } from "@/lib/billing/checkout-intent";
import { cloudAccountBillingUrl } from "@/lib/cloud-runtime-url";
import * as sdkGen from "@/generated/api/sdk.gen";
import * as browserRuntime from "@/runtime/browser";
import * as orgReadyMod from "@/hooks/use-is-org-ready";

const CHECKOUT_URL = "https://stripe.test/checkout/session";
const INTENT_KEY = "cadet.pro-checkout-intent";
const ENTRY = "/assistant/checkout?package=super";

type Captured = { body?: unknown };
const upgradeCalls: Captured[] = [];
let openedUrl: string | null = null;

mock.module("@/generated/api/sdk.gen", () => ({
  ...sdkGen,
  organizationsBillingSubscriptionUpgradeCreate: (opts: Captured) => {
    upgradeCalls.push(opts);
    return Promise.resolve({
      data: { status: "redirect", checkout_url: CHECKOUT_URL, message: "" },
      response: { ok: true },
    });
  },
}));

mock.module("@/runtime/browser", () => ({
  ...browserRuntime,
  openUrl: (url: string) => {
    openedUrl = url;
    return Promise.resolve();
  },
}));

// Org readiness and the funnel flag are settled here so the cloud session is
// the only thing the page is waiting on.
mock.module("@/hooks/use-is-org-ready", () => ({
  ...orgReadyMod,
  useOrgHeaderReadiness: () => "ready",
}));

const { useGatewaySessionStore } = await import(
  "@/stores/gateway-session-store"
);
const { CheckoutPage } = await import("./checkout-page");

const initialSeamState = useGatewaySessionStore.getState();

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="loc">{location.pathname + location.search}</div>;
}

function renderCheckout() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <MemoryRouter initialEntries={[ENTRY]}>
      <QueryClientProvider client={client}>
        <Routes>
          <Route path="/assistant/checkout" element={<CheckoutPage />} />
          <Route path="*" element={null} />
        </Routes>
      </QueryClientProvider>
      <LocationProbe />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  upgradeCalls.length = 0;
  openedUrl = null;
  sessionStorage.removeItem(INTENT_KEY);
  useGatewaySessionStore.setState(initialSeamState, true);
});

afterEach(() => {
  cleanup();
});

describe("CheckoutPage — cold reload", () => {
  test("a probe that resolves present shortly after mount proceeds to checkout", async () => {
    // The reload window: signed in, platform liveness not yet known.
    useGatewaySessionStore.setState({
      settled: true,
      live: true,
      cloudLive: false,
      cloudSettled: false,
    });

    const { getByLabelText, getByTestId } = renderCheckout();

    // Nothing is decided yet, so the route holds rather than bailing — a bail
    // here throws away a session that is about to confirm.
    getByLabelText("Preparing checkout");
    expect(upgradeCalls.length).toBe(0);
    expect(getByTestId("loc").textContent).toBe(ENTRY);

    act(() => {
      useGatewaySessionStore.setState({ cloudLive: true, cloudSettled: true });
    });

    await waitFor(() => expect(upgradeCalls.length).toBe(1));
    await waitFor(() => expect(openedUrl).toBe(CHECKOUT_URL));
    expect(getByTestId("loc").textContent).toBe(ENTRY);
  });

  test("a settled-absent session still hands off to the cloud's billing page and drops the stash", async () => {
    useGatewaySessionStore.setState({
      settled: true,
      live: false,
      cloudLive: false,
      cloudSettled: true,
    });
    saveCheckoutIntent({
      kind: "package",
      packageKey: "super",
      resumeAfterOnboarding: true,
    });

    const { getByTestId } = renderCheckout();

    await waitFor(() => expect(openedUrl).toBe(cloudAccountBillingUrl()));
    expect(getByTestId("loc").textContent).toBe(ENTRY);
    expect(upgradeCalls.length).toBe(0);
    expect(sessionStorage.getItem(INTENT_KEY)).toBeNull();
  });
});
