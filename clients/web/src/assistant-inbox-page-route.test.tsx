/**
 * The inbox route as the wizard lands on it after an upgrade: entitled, with
 * no address and no domain, it is the setup card with the handle open; once
 * Confirm registers the address, it is the mailbox. Since #774 the email and
 * domain surfaces are plain `fetch` at scoped assistant paths — no generated
 * sdk to mock — so the data seam is a fetch router below; the daemon legs
 * stay mocked at their generated module boundary.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";

import * as activeAssistantIdModule from "@/assistant/use-active-assistant-id";
import type { AssistantDomain } from "@/lib/assistant-domains";
import type { EmailAddress } from "@/lib/email-api";
import * as daemonSdk from "@/generated/daemon/sdk.gen";
import * as assistantAvatarMod from "@/hooks/use-assistant-avatar";
import * as cloudGate from "@/assistant/hosting";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useResolvedAssistantStore } from "@/stores/resolved-assistant-store";

const ASSISTANT_ID = "assistant-1";
mock.module("@/assistant/use-active-assistant-id", () => ({
  ...activeAssistantIdModule,
  useActiveAssistantId: () => ASSISTANT_ID,
}));

mock.module("@/assistant/hosting", () => ({
  ...cloudGate,
  useActiveAssistantIsCloudHosted: () => true,
  useAssistantHosting: () => "cloud",
}));

mock.module("@/hooks/use-assistant-avatar", () => ({
  ...assistantAvatarMod,
  useAssistantAvatar: () => ({
    components: null,
    traits: null,
    customImageUrl: null,
    isLoading: false,
    invalidate: () => {},
  }),
}));

// The design library's index re-exports every name from this module, so the
// stand-in has to carry them all or the import graph fails to link.
const toastSuccessCalls: string[] = [];
mock.module("@mycadet/design-library/components/toast", () => ({
  toast: {
    success: (message: string) => {
      toastSuccessCalls.push(message);
    },
    error: () => {},
    info: () => {},
  },
  Toaster: () => null,
  ToastContent: () => null,
}));

mock.module("@/lib/error-reporting/capture-error", () => ({
  captureError: () => {},
}));

/** The address list, empty until setup registers one. */
let addresses: EmailAddress[] = [];
/** The domain list, empty on a fresh upgrade. */
let domains: AssistantDomain[] = [];
const domainCreateBodies: unknown[] = [];
/** When set, the domain is claimed but the address on it is not made. */
let domainEmailError: { detail: string; code: string } | null = null;

/**
 * The operator surface the route reads is plain fetch at scoped assistant
 * paths (lib/email-api, lib/assistant-domains), so this router is the data
 * seam: fixtures ride the real hooks, cache keys, and zod parsing. Unrouted
 * calls answer 404 loudly instead of leaking to the network.
 */
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

// The operator paths key on the RESOLVED assistant's id (the handle, from
// the store), not the active-assistant id — match on the tail after the id.
const routes = new Map<string, (init?: RequestInit) => Promise<Response>>();

routes.set(`GET email-addresses/`, () =>
  Promise.resolve(json({ results: addresses })),
);
routes.set(`GET domains/`, () => Promise.resolve(json({ results: domains })));
// The mailbox's message list mounts with the inbox open.
routes.set(`GET emails/`, () => Promise.resolve(json({ results: [] })));
routes.set(`POST domains/`, async (init) => {
  domainCreateBodies.push(JSON.parse(init?.body as string));
  // One call registers the subdomain and, as a best effort, the address
  // on it; a failed address comes back as a field on the success.
  const domain = {
    id: "domain-1",
    subdomain: "bright-vole-02a64h",
    created: "2026-09-22T00:00:00Z",
    modified: "2026-09-22T00:00:00Z",
    ...(domainEmailError ? { email_error: domainEmailError } : {}),
  };
  domains = [domain];
  if (!domainEmailError) {
    addresses = [
      {
        id: "address-1",
        address: "hi@bright-vole-02a64h.cadet.me",
        created_at: "2026-09-22T00:00:00Z",
      },
    ];
  }
  return json(domain);
});

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = String(input).split("?")[0];
  // .../v1/assistants/{id}/{tail} — the tail carries the surface.
  const tail = path.split("/assistants/")[1]?.split("/").slice(1).join("/");
  const handler = routes.get(
    `${(init?.method ?? "GET").toUpperCase()} ${tail ?? ""}`,
  );
  if (!handler) {
    return json(
      { detail: `test fetch router has no route for ${String(input)}` },
      404,
    );
  }
  return handler(init);
}) as typeof fetch;

mock.module("@/generated/daemon/sdk.gen", () => ({
  ...daemonSdk,
  channelsReadinessRefreshPost: () =>
    Promise.resolve({ data: {}, response: { ok: true } }),
}));

const { AssistantInboxPageRoute } =
  await import("./assistant-inbox-page-route");

function renderRoute() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/assistant/inbox"]}>
        <AssistantInboxPageRoute />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  addresses = [];
  domains = [];
  domainCreateBodies.length = 0;
  domainEmailError = null;
  toastSuccessCalls.length = 0;
  useAssistantIdentityStore.setState({ name: "Ziggy" });
  // The store IS the listing: the handle the setup card offers is the
  // entry's id until a domain lands.
  useResolvedAssistantStore.getState().setAssistant({
    cloud: "cloud",
    assistantId: "bright-vole-02a64h",
    name: "Ziggy",
    hatchedAt: "2026-09-22T00:00:00Z",
  });
});

afterEach(() => {
  cleanup();
});

describe("AssistantInboxPageRoute after an upgrade", () => {
  test("with no address and no domain, offers setup with the handle open, then shows the inbox once the address exists", async () => {
    renderRoute();

    // The setup card, with the handle as a field the user can still choose.
    const handle = (await screen.findByLabelText(
      "Handle (public)",
    )) as HTMLInputElement;
    expect(handle.value).toBe("bright-vole-02a64h");
    expect(handle.readOnly).toBe(false);
    expect(
      screen.getByText(
        "The handle becomes your assistant's public handle. You won't be able to change it once set.",
      ),
    ).toBeTruthy();
    expect(screen.queryByTestId("assistant-inbox-header")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    // One registration, the handle as the subdomain and the prefix on it.
    await waitFor(() => expect(domainCreateBodies.length).toBe(1));
    expect(domainCreateBodies[0]).toEqual({
      subdomain: "bright-vole-02a64h",
      email_username: "hi",
    });

    // The address now exists: the success screen first, then the mailbox.
    await waitFor(() =>
      expect(screen.getByTestId("assistant-inbox-setup-success")).toBeTruthy(),
    );
    // The way in appears once the line has typed itself out.
    const openInbox = await screen.findByRole("button", { name: "Open inbox" });
    fireEvent.click(openInbox);
    await waitFor(() =>
      expect(screen.getByTestId("assistant-inbox-header")).toBeTruthy(),
    );
    expect(screen.queryByLabelText("Handle (public)")).toBeNull();
    // The success screen is the confirmation; no toast doubles it.
    expect(toastSuccessCalls.length).toBe(0);
  });

  test("a claimed subdomain whose address could not be made is an error, not a ready address", async () => {
    domainEmailError = {
      detail:
        'Failed to provision email domain: {"statusCode":403,"message":"You have reached the domain limit of your plan. Upgrade to add more.","name":"validation_error"}',
      code: "resend_domain_error",
    };
    renderRoute();

    await screen.findByLabelText("Handle (public)");
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(domainCreateBodies.length).toBe(1));
    // The provider's sentence, under the fields, and no claim of readiness.
    await waitFor(() =>
      expect(
        screen.getByText(
          "Failed to provision email domain: You have reached the domain limit of your plan. Upgrade to add more.",
        ),
      ).toBeTruthy(),
    );
    expect(toastSuccessCalls).toEqual([]);
    expect(screen.queryByTestId("assistant-inbox-header")).toBeNull();
    // The subdomain is claimed now, so the handle is settled and only the
    // prefix is left to choose.
    await waitFor(() =>
      expect(screen.queryByLabelText("Handle (public)")).toBeNull(),
    );
  });

  test("with an address already registered, opens straight onto the inbox", async () => {
    domains = [
      {
        id: "domain-1",
        subdomain: "bright-vole-02a64h",
        created: "2026-09-22T00:00:00Z",
        modified: "2026-09-22T00:00:00Z",
      },
    ];
    addresses = [
      {
        id: "address-1",
        address: "hi@bright-vole-02a64h.cadet.me",
        created_at: "2026-09-22T00:00:00Z",
      },
    ];
    renderRoute();

    await waitFor(() =>
      expect(screen.getByTestId("assistant-inbox-header")).toBeTruthy(),
    );
    expect(screen.queryByText("Assistant Email")).toBeNull();
  });
});
