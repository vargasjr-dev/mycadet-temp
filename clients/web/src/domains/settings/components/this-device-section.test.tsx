/**
 * Tests for `ThisDeviceSection`.
 *
 * The section exists so a paired browser can name its own device row: the
 * gateway stores only the hashed device id, so the section shows that hash
 * (copyable) and disappears entirely when there is no paired gateway
 * session or the gateway cannot answer.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { ThisDeviceSection } from "@/domains/settings/components/this-device-section";
import { setSelfHostedConnection } from "@/lib/self-hosted/connection";

const realFetch = globalThis.fetch;

function withPreconnect(
  impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return Object.assign(impl, { preconnect: () => {} });
}

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  setSelfHostedConnection(null);
});

describe("ThisDeviceSection", () => {
  test("shows the paired device's hashed id with a copy affordance", async () => {
    setSelfHostedConnection({ url: "http://localhost:7830", token: "tok-1" });
    globalThis.fetch = withPreconnect(async () =>
      new Response(
        JSON.stringify({
          device: {
            hashedDeviceId: "deadbeef" + "0".repeat(56),
            platform: "web",
            pairingUserAgent: null,
            clientReportedName: null,
            issuedAt: 1_000,
            expiresAt: 2_000,
            lastUsedAt: null,
          },
        }),
        { status: 200 },
      ),
    );

    render(<ThisDeviceSection />);
    await waitFor(() =>
      expect(screen.getByText(/deadbeef/)).toBeTruthy(),
    );
    expect(screen.getByRole("button", { name: /copy/i })).toBeTruthy();
  });

  test("renders nothing without a paired gateway session", async () => {
    setSelfHostedConnection(null);
    globalThis.fetch = withPreconnect(async () => {
      throw new Error("must not be called");
    });

    const { container } = render(<ThisDeviceSection />);
    await waitFor(() => expect(container.textContent).toBe(""));
  });

  test("renders nothing when the gateway cannot answer", async () => {
    setSelfHostedConnection({ url: "http://localhost:7830", token: "tok-1" });
    globalThis.fetch = withPreconnect(async () => new Response(null, { status: 403 }));

    const { container } = render(<ThisDeviceSection />);
    await waitFor(() => expect(container.textContent).toBe(""));
  });
});
