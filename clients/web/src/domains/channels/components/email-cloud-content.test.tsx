/**
 * Repair flow for an already-claimed managed domain whose provider status is
 * `not_started`. The address stays read-only; Complete domain setup calls the
 * bodyless provision dial and resumes verification polling only after the
 * provider leaves `not_started`.
 *
 * The mail dials are host-served now (the operator api's email rows), so the
 * tests intercept the wire itself — a mocked fetch answering the four reads
 * and recording the provision POST — instead of mocking the generated cloud
 * sdk the component no longer touches.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";

import { emailKeys } from "@/lib/email-api";
import { domainKeys } from "@/lib/assistant-domains";

const ASSISTANT_ID = "assistant-123";
const DOMAIN_ID = "domain-123";
const ADDRESS_ID = "email-123";
const ADDRESS = "user@example.com";
const SUBDOMAIN = "my-assistant";
const ROOT_DOMAIN = "example.com";

type VerificationStatus =
  | "verified"
  | "pending"
  | "failed"
  | "not_started"
  | "unknown";

const toastSuccessCalls: string[] = [];
const toastErrorCalls: string[] = [];
const captureErrorCalls: Array<{ err: unknown; context?: string }> = [];
/** Every provision POST the component dialed: the url and the init. */
const provisionCalls: Array<{ url: string; init?: RequestInit }> = [];

let verificationStatus: ReturnType<typeof makeVerification>;
let provisionImpl: () => Promise<Record<string, unknown> | Response>;

const emailScope = `/v1/assistants/${ASSISTANT_ID}`;

/** The wire: the four reads answer from fixtures, the provision POST records. */
async function serveMail(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
  if (path === `${emailScope}/domains/` && (init?.method ?? "GET") === "GET") {
    return Response.json({ results: [makeDomain()] });
  }
  if (
    path === `${emailScope}/email-addresses/` &&
    (init?.method ?? "GET") === "GET"
  ) {
    return Response.json({ results: [makeAddress()] });
  }
  if (
    path ===
      `${emailScope}/domains/${DOMAIN_ID}/verification-status/` &&
    (init?.method ?? "GET") === "GET"
  ) {
    return Response.json(verificationStatus);
  }
  if (
    path ===
      `${emailScope}/email-addresses/${ADDRESS_ID}/status/` &&
    (init?.method ?? "GET") === "GET"
  ) {
    return Response.json(makeAddressStatus());
  }
  if (
    path === `${emailScope}/domains/${DOMAIN_ID}/provision/` &&
    init?.method === "POST"
  ) {
    provisionCalls.push({ url, init });
    const result = await provisionImpl();
    // A test failure returns the refusal body itself, so the dial reads
    // the detail out of it the way the real 400 flows.
    return result instanceof Response
      ? result
      : Response.json(result);
  }
  throw new Error(`unexpected dial in test: ${init?.method ?? "GET"} ${path}`);
}

const realFetch = globalThis.fetch;

mockFetch();

function mockFetch() {
  // happy-dom supplies its own fetch bound to the fake origin
  // (window.location = http://localhost:3000 in test-setup.ts), so the
  // mock has to ride the window's fetch, not a fresh global.
  const mocked = (async (input: RequestInfo | URL, init?: RequestInit) =>
    serveMail(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url,
      init,
    )) as typeof fetch;
  globalThis.fetch = mocked;
  window.fetch = mocked;
}

mock.module("@mycadet/design-library/components/toast", () => ({
  toast: {
    success: (message: string) => {
      toastSuccessCalls.push(message);
    },
    error: (message: string) => {
      toastErrorCalls.push(message);
    },
  },
  Toaster: () => null,
  ToastContent: () => null,
}));

mock.module("@/lib/error-reporting/capture-error", () => ({
  captureError: (err: unknown, opts?: { context?: string }) => {
    captureErrorCalls.push({ err, context: opts?.context });
  },
}));

mock.module("@/assistant/use-active-assistant-id", () => ({
  useActiveAssistantId: () => ASSISTANT_ID,
}));

const {
  EmailCloudContent,
  DOMAIN_VERIFICATION_POLL_MS,
  domainVerificationRefetchInterval,
} = await import("@/domains/channels/components/email-cloud-content");

function makeDomain() {
  return {
    id: DOMAIN_ID,
    subdomain: SUBDOMAIN,
    created: "2026-01-01T00:00:00Z",
    modified: "2026-01-01T00:00:00Z",
  };
}

function makeAddress() {
  return {
    id: ADDRESS_ID,
    address: ADDRESS,
    created_at: "2026-01-01T00:00:00Z",
  };
}

function makeAddressStatus() {
  return {
    address: ADDRESS,
    status: "active",
    usage: {
      sent_today: 0,
      daily_limit: 100,
      received_today: 0,
      sent_this_month: 0,
      received_this_month: 0,
    },
    created_at: "2026-01-01T00:00:00Z",
  };
}

function makeVerification(status: VerificationStatus) {
  return {
    domain: `${SUBDOMAIN}.${ROOT_DOMAIN}`,
    status,
    message:
      status === "not_started"
        ? "Domain has not been provisioned with the email provider yet."
        : status,
  };
}

function seedClient(client: QueryClient, status: VerificationStatus): void {
  client.setQueryData(domainKeys.domains(ASSISTANT_ID), [makeDomain()]);
  client.setQueryData(emailKeys.emailAddresses(ASSISTANT_ID), [makeAddress()]);
  client.setQueryData(
    domainKeys.domainVerificationStatus(ASSISTANT_ID, DOMAIN_ID),
    makeVerification(status),
  );
  client.setQueryData(
    emailKeys.emailAddressStatus(ASSISTANT_ID, ADDRESS_ID),
    makeAddressStatus(),
  );
}

function renderManaged(status: VerificationStatus): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  seedClient(client, status);
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <EmailCloudContent emailRootDomain={ROOT_DOMAIN} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

function confirmRepairButton(): HTMLButtonElement | null {
  return document.querySelector("[data-confirm-dialog-confirm]");
}

function verificationRefetchInterval(
  client: QueryClient,
):
  | number
  | false
  | ((query: {
      state: { data?: { status?: VerificationStatus } };
    }) => number | false)
  | undefined {
  const query = client.getQueryCache().find({
    queryKey: domainKeys.domainVerificationStatus(ASSISTANT_ID, DOMAIN_ID),
  });
  return query?.observers[0]?.options.refetchInterval as
    | number
    | false
    | ((query: {
        state: { data?: { status?: VerificationStatus } };
      }) => number | false)
    | undefined;
}

beforeEach(() => {
  // Re-install per test: the previous test's afterEach puts the real
  // fetch back, and this suite's mounts dial the wire otherwise.
  mockFetch();
  toastSuccessCalls.length = 0;
  toastErrorCalls.length = 0;
  captureErrorCalls.length = 0;
  provisionCalls.length = 0;
  verificationStatus = makeVerification("not_started");
  provisionImpl = async () => {
    verificationStatus = makeVerification("pending");
    return verificationStatus;
  };
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  window.fetch = realFetch;
});

describe("domainVerificationRefetchInterval", () => {
  test("stops polling for not_started, verified, and failed", () => {
    expect(domainVerificationRefetchInterval("not_started")).toBe(false);
    expect(domainVerificationRefetchInterval("verified")).toBe(false);
    expect(domainVerificationRefetchInterval("failed")).toBe(false);
  });

  test("polls pending and other nonterminal provider-check states", () => {
    expect(domainVerificationRefetchInterval("pending")).toBe(
      DOMAIN_VERIFICATION_POLL_MS,
    );
    expect(domainVerificationRefetchInterval("unknown")).toBe(
      DOMAIN_VERIFICATION_POLL_MS,
    );
    expect(domainVerificationRefetchInterval(undefined)).toBe(
      DOMAIN_VERIFICATION_POLL_MS,
    );
  });
});

describe("EmailCloudContent domain setup repair", () => {
  test.each(["verified", "pending", "failed", "unknown"] as const)(
    "%s does not render the repair action",
    (status) => {
      renderManaged(status);

      expect(screen.getByDisplayValue(ADDRESS)).toBeTruthy();
      expect(
        screen.queryByRole("button", { name: "Complete domain setup" }),
      ).toBeNull();
      expect(
        screen.queryByText(
          "Your email address is ready, but this domain is not set up with the email provider yet. Complete setup to start sending and receiving mail.",
        ),
      ).toBeNull();
    },
  );

  test("confirming repair calls the provision dial once with the existing ids and no body", async () => {
    renderManaged("not_started");

    fireEvent.click(
      screen.getByRole("button", { name: "Complete domain setup" }),
    );
    fireEvent.click(confirmRepairButton()!);

    await waitFor(() => {
      expect(provisionCalls).toHaveLength(1);
    });

    const call = provisionCalls[0];
    expect(call.url).toBe(
      `${emailScope}/domains/${DOMAIN_ID}/provision/`,
    );
    expect(call.init?.method).toBe("POST");
    expect(call.init?.body).toBeUndefined();
  });

  test("duplicate submissions are disabled while pending", async () => {
    let resolveProvision:
      | ((value: Record<string, unknown> | Response) => void)
      | undefined;
    provisionImpl = () =>
      new Promise((resolve) => {
        resolveProvision = resolve;
      });

    renderManaged("not_started");
    fireEvent.click(
      screen.getByRole("button", { name: "Complete domain setup" }),
    );
    fireEvent.click(confirmRepairButton()!);

    await waitFor(() => {
      expect(confirmRepairButton()?.disabled).toBe(true);
    });

    fireEvent.click(confirmRepairButton()!);
    expect(provisionCalls).toHaveLength(1);
    expect(document.body.textContent).toContain("Completing setup…");
    expect(confirmRepairButton()?.disabled).toBe(true);

    resolveProvision?.(makeVerification("pending"));
  });

  test("success updates verification state and resumes pending polling", async () => {
    const client = renderManaged("not_started");

    const intervalBefore = verificationRefetchInterval(client);
    expect(typeof intervalBefore).toBe("function");
    if (typeof intervalBefore === "function") {
      expect(
        intervalBefore({ state: { data: { status: "not_started" } } }),
      ).toBe(false);
    }

    fireEvent.click(
      screen.getByRole("button", { name: "Complete domain setup" }),
    );
    fireEvent.click(confirmRepairButton()!);

    await waitFor(() => {
      expect(screen.getByText("Verifying domain…")).toBeTruthy();
    });

    expect(
      screen.queryByRole("button", { name: "Complete domain setup" }),
    ).toBeNull();
    expect(toastSuccessCalls).toEqual([
      "Domain setup started. Verification usually takes a few minutes.",
    ]);

    const cached = client.getQueryData(
      domainKeys.domainVerificationStatus(ASSISTANT_ID, DOMAIN_ID),
    ) as { status?: VerificationStatus } | undefined;
    expect(cached?.status).toBe("pending");

    const intervalAfter = verificationRefetchInterval(client);
    expect(typeof intervalAfter).toBe("function");
    if (typeof intervalAfter === "function") {
      expect(intervalAfter({ state: { data: { status: "pending" } } })).toBe(
        DOMAIN_VERIFICATION_POLL_MS,
      );
    }
  });

  test("failure keeps repair available and surfaces a retryable error", async () => {
    provisionImpl = async () =>
      new Response(
        JSON.stringify({
          detail: "Email provider is temporarily unavailable.",
        }),
        { status: 400 },
      );

    renderManaged("not_started");
    fireEvent.click(
      screen.getByRole("button", { name: "Complete domain setup" }),
    );
    fireEvent.click(confirmRepairButton()!);

    await waitFor(() => {
      expect(toastErrorCalls).toEqual([
        "Email provider is temporarily unavailable.",
      ]);
    });

    expect(captureErrorCalls[0]?.context).toBe("email_domain_provision");
    expect(screen.getByDisplayValue(ADDRESS)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Complete domain setup" }),
    ).toBeTruthy();
    expect(confirmRepairButton()).toBeTruthy();
    expect(confirmRepairButton()?.disabled).toBe(false);
    expect(
      screen.getByText("Email provider is temporarily unavailable."),
    ).toBeTruthy();
  });

  test("not_started does not attach a ten-second poll before repair", () => {
    const client = renderManaged("not_started");
    const interval = verificationRefetchInterval(client);
    expect(typeof interval).toBe("function");
    if (typeof interval === "function") {
      expect(interval({ state: { data: { status: "not_started" } } })).toBe(
        false,
      );
    }
  });
});
