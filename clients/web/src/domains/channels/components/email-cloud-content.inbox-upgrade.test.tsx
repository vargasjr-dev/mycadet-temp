import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router";

import {
  assistantsDomainsListOptions,
  assistantsEmailAddressesListOptions,
  assistantsListQueryKey,
  organizationsBillingSubscriptionRetrieveOptions,
} from "@/generated/api/@tanstack/react-query.gen";
import type {
  AssistantDomain,
  SubscriptionResponse,
} from "@/generated/api/types.gen";

const ASSISTANT_ID = "assistant-123";

mock.module("@/assistant/use-active-assistant-id", () => ({
  useActiveAssistantId: () => ASSISTANT_ID,
}));

// The design library's index re-exports every name from this module, so the
// stand-in has to carry them all or the import graph fails to link.
mock.module("@mycadet/design-library/components/toast", () => ({
  toast: { success: () => {}, error: () => {}, info: () => {} },
  Toaster: () => null,
  ToastContent: () => null,
}));

const { EmailCloudContent } = await import("./email-cloud-content");

const ENTITLED = {
  plan_id: "base",
  status: "active",
  entitlements: { cloud_email: true, phone_number: false },
} as unknown as SubscriptionResponse;

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="loc">{location.pathname}</div>;
}

/** Entitled, with the domain and address lists answered from the cache. */
function renderEntitled({ domain }: { domain: AssistantDomain | null }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(
    organizationsBillingSubscriptionRetrieveOptions().queryKey,
    ENTITLED,
  );
  const path = { path: { assistant_id: ASSISTANT_ID } };
  client.setQueryData(assistantsDomainsListOptions(path).queryKey, {
    count: domain ? 1 : 0,
    next: null,
    previous: null,
    results: domain ? [domain] : [],
  });
  client.setQueryData(assistantsEmailAddressesListOptions(path).queryKey, {
    count: 0,
    next: null,
    previous: null,
    results: [],
  });
  client.setQueryData(assistantsListQueryKey(), {
    results: [{ id: ASSISTANT_ID, handle: "ada" }],
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/assistant/channels/email"]}>
        <EmailCloudContent
          assistantId={ASSISTANT_ID}
          emailRootDomain="example.com"
        />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
});

describe("EmailCloudContent · entitled, no address", () => {
  test("points to the inbox instead of registering a domain", () => {
    renderEntitled({ domain: null });

    expect(
      screen.getByText("Set up email in the Assistant Inbox"),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Register" })).toBeNull();

    fireEvent.click(screen.getByTestId("email-inbox-setup-button"));

    expect(screen.getByTestId("loc").textContent).toBe("/assistant/inbox");
  });

  test("with a domain but no address, keeps the domain row and points to the inbox for the address", () => {
    renderEntitled({
      domain: { domain: "example.com" } as unknown as AssistantDomain,
    });

    // The domain row, with its release action, is still this page's.
    expect(screen.getByText("ada.example.com")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Release domain" })).toBeTruthy();
    // The address field is not: the inbox's card creates the address.
    expect(screen.queryByRole("button", { name: "Create" })).toBeNull();
    expect(screen.getByTestId("email-inbox-setup-button")).toBeTruthy();
  });
});
