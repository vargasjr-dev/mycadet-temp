import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";

// The implementation `@app/lib/auth/remote-gateway-session` re-exports,
// imported from its owner so the mock below hands the page the production
// parser.
import { parseRemoteWebPairingParams } from "@mycadet/service-contracts/remote-web-pairing";

import type { RemoteWebPairingTokenResult } from "@app/lib/auth/remote-gateway-session";

let cloudRemote = false;
const nativeSwitchToOriginPathMock = mock(
  async (_url: string | null, _path: string) => false,
);

mock.module("@app/lib/runtime-mode", () => ({
  isLocalClient: () => !cloudRemote,
}));

mock.module("@app/runtime/self-hosted-servers", () => ({
  nativeSwitchToOriginPath: nativeSwitchToOriginPathMock,
}));

const exchangeRemoteWebPairingTokenMock = mock(
  async (
    _deviceCode: string,
    _signal?: AbortSignal,
  ): Promise<RemoteWebPairingTokenResult> => ({
    status: "pending",
    expiresAt: "2026-06-16T12:00:00.000Z",
    intervalSeconds: 5,
  }),
);
const activateRemoteGatewaySessionMock = mock((_session: unknown) => {});

const APPROVED_RESULT: RemoteWebPairingTokenResult = {
  status: "approved",
  accessToken: "access-token",
  accessTokenExpiresAt: "2999-01-01T00:00:00.000Z",
  refreshAfter: "2999-01-01T00:00:00.000Z",
  guardianId: "guardian-1",
  assistantId: "assistant-1",
};

class MockRemoteWebPairingError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(status: number, message: string, code: string | null = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

mock.module("@app/lib/auth/remote-gateway-session", () => ({
  activateRemoteGatewaySession: activateRemoteGatewaySessionMock,
  exchangeRemoteWebPairingToken: exchangeRemoteWebPairingTokenMock,
  // The real parser, not a stand-in: production links carry the device code
  // in the FRAGMENT and in snake_case, which a query-only mock reads as null.
  parseRemoteWebPairingParams,
  RemoteWebPairingError: MockRemoteWebPairingError,
}));

const { PairingPage } = await import("@app/domains/account/pages/pairing-page");

afterEach(() => {
  cleanup();
  cloudRemote = false;
  exchangeRemoteWebPairingTokenMock.mockClear();
  activateRemoteGatewaySessionMock.mockClear();
  nativeSwitchToOriginPathMock.mockReset();
  nativeSwitchToOriginPathMock.mockImplementation(async () => false);
});

describe("PairingPage", () => {
  test("renders NotFound on a cloud remote", () => {
    cloudRemote = true;

    render(
      <MemoryRouter
        initialEntries={["/account/pair?deviceCode=device-1&userCode=ABCD"]}
      >
        <PairingPage />
      </MemoryRouter>,
    );

    expect(screen.getByText("Page not found")).not.toBeNull();
    expect(exchangeRemoteWebPairingTokenMock).not.toHaveBeenCalled();
  });

  test("polls for a token in remote-gateway mode", async () => {
    render(
      <MemoryRouter
        initialEntries={["/account/pair?deviceCode=device-1&userCode=ABCD"]}
      >
        <PairingPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Waiting for approval")).not.toBeNull();
    expect(exchangeRemoteWebPairingTokenMock.mock.calls[0]?.[0]).toBe(
      "device-1",
    );
    expect(exchangeRemoteWebPairingTokenMock.mock.calls[0]?.[1]).toBeInstanceOf(
      AbortSignal,
    );
  });

  test("cancel uses the native origin switch when available", async () => {
    nativeSwitchToOriginPathMock.mockResolvedValueOnce(true);
    const assignMock = mock((_url: string) => {});
    const originalAssign = window.location.assign;
    Object.defineProperty(window.location, "assign", {
      value: assignMock,
      configurable: true,
    });

    try {
      render(
        <MemoryRouter
          initialEntries={["/account/pair?deviceCode=device-1&userCode=ABCD"]}
        >
          <PairingPage />
        </MemoryRouter>,
      );

      expect(await screen.findByText("Waiting for approval")).not.toBeNull();
      fireEvent.click(screen.getByText("Cancel"));

      await waitFor(() => {
        expect(nativeSwitchToOriginPathMock).toHaveBeenCalledWith(
          window.location.origin,
          "/account/select-assistant",
        );
      });
      expect(assignMock).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window.location, "assign", {
        value: originalAssign,
        configurable: true,
      });
    }
  });

  test("asks for a pairing code when opened without one", () => {
    const { container } = render(
      <MemoryRouter initialEntries={["/account/pair"]}>
        <PairingPage />
      </MemoryRouter>,
    );

    expect(screen.getByText("Pair a device")).not.toBeNull();
    expect(screen.getByText(/run "cadet pair"/)).not.toBeNull();
    expect(screen.getByLabelText("Pairing code")).not.toBeNull();
    expect(container.querySelector(".animate-spin")).toBeNull();
    expect(exchangeRemoteWebPairingTokenMock).not.toHaveBeenCalled();
  });

  test("polls the exchange with an entered pairing code", async () => {
    render(
      <MemoryRouter initialEntries={["/account/pair"]}>
        <PairingPage />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText("Pairing code"), {
      target: { value: "  typed-code  " },
    });
    fireEvent.click(screen.getByText("Pair"));

    expect(screen.getByText("Pairing")).not.toBeNull();
    await waitFor(() => {
      expect(exchangeRemoteWebPairingTokenMock.mock.calls[0]?.[0]).toBe(
        "typed-code",
      );
    });
  });

  test("surfaces guardian-repair guidance on a repair-required exchange failure", async () => {
    exchangeRemoteWebPairingTokenMock.mockImplementationOnce(async () => {
      throw new MockRemoteWebPairingError(
        503,
        "Pairing token exchange failed: 503",
        "GUARDIAN_REPAIR_REQUIRED",
      );
    });

    render(
      <MemoryRouter
        initialEntries={["/account/pair?deviceCode=device-1&userCode=ABCD"]}
      >
        <PairingPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Pairing failed")).not.toBeNull();
    expect(screen.getByText(/trust database needs repair/)).not.toBeNull();
    expect(screen.getByText(/retry this same pairing link/)).not.toBeNull();
    expect(screen.queryByText(/starting a new pairing/)).toBeNull();
  });

  test("keeps new-pairing guidance for other exchange failures", async () => {
    exchangeRemoteWebPairingTokenMock.mockImplementationOnce(async () => {
      throw new MockRemoteWebPairingError(
        503,
        "Pairing token exchange failed: 503",
      );
    });

    render(
      <MemoryRouter
        initialEntries={["/account/pair?deviceCode=device-1&userCode=ABCD"]}
      >
        <PairingPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Pairing failed")).not.toBeNull();
    expect(screen.getByText(/Try starting a new pairing/)).not.toBeNull();
    expect(screen.queryByText(/trust database needs repair/)).toBeNull();
  });

  test("goes straight to paired for a pre-approved code, without flashing the approval code", async () => {
    exchangeRemoteWebPairingTokenMock.mockImplementationOnce(
      async () => APPROVED_RESULT,
    );

    render(
      <MemoryRouter
        initialEntries={[
          "/account/pair?deviceCode=fast-code&userCode=WXYZ-1234",
        ]}
      >
        <PairingPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Connected")).not.toBeNull();
    expect(activateRemoteGatewaySessionMock).toHaveBeenCalledTimes(1);
    // The pre-approved arrival never shows the approval-code / waiting UI.
    expect(screen.queryByText("Waiting for approval")).toBeNull();
    expect(screen.queryByText("Pairing code")).toBeNull();
    expect(screen.queryByText("WXYZ-1234")).toBeNull();
  });

  test("offers entering a new code after the pairing expires", async () => {
    exchangeRemoteWebPairingTokenMock.mockImplementationOnce(async () => {
      throw new MockRemoteWebPairingError(
        401,
        "Pairing token exchange failed: 401",
      );
    });

    render(
      <MemoryRouter initialEntries={["/account/pair?deviceCode=old-code"]}>
        <PairingPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Pairing expired")).not.toBeNull();

    fireEvent.click(screen.getByText("Enter a new code"));

    expect(screen.getByText("Pair a device")).not.toBeNull();
    expect(screen.getByText("Pair")).not.toBeNull();
  });

  test("still shows the waiting state and code when the code is not yet approved", async () => {
    // Default mock returns pending — the not-pre-approved device-code path.

    render(
      <MemoryRouter
        initialEntries={["/account/pair?deviceCode=slow-code&userCode=ABCD"]}
      >
        <PairingPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Waiting for approval")).not.toBeNull();
    expect(screen.getByText("Pairing code")).not.toBeNull();
    expect(screen.getByText("ABCD")).not.toBeNull();
  });
});
