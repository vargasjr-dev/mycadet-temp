import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";

// The implementation `@/lib/auth/remote-gateway-session` re-exports, imported
// from its owner so the mock below hands the page the production parser.
import { parseRemoteWebPairingParams } from "@mycadet/service-contracts/remote-web-pairing";

import type { RemoteWebPairingTokenResult } from "@/lib/auth/remote-gateway-session";

let cloudRemote = false;
let injectedAssistantName: string | undefined;
let injectedHubUrl: string | undefined;
let nativePlatform = false;
let nativePlatformName: "ios" | "android" = "ios";
const nativeSwitchToOriginPathMock = mock(
  async (_url: string | null, _path: string) => false,
);

mock.module("@/lib/local-mode", () => ({
  isCadetCloudRemote: () => cloudRemote,
  getRemoteGatewayAssistantName: () => injectedAssistantName,
  getRemoteGatewayHubUrl: () => injectedHubUrl,
}));

mock.module("@/runtime/native-auth", () => ({
  isNativePlatform: () => nativePlatform,
}));

mock.module("@/runtime/self-hosted-servers", () => ({
  nativeSwitchToOriginPath: nativeSwitchToOriginPathMock,
}));

mock.module("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => nativePlatform,
    getPlatform: () => (nativePlatform ? nativePlatformName : "web"),
  },
}));

const ORIGINAL_USER_AGENT = navigator.userAgent;
const IPHONE_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) " +
  "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const ANDROID_USER_AGENT =
  "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36";

function setUserAgent(userAgent: string): void {
  Object.defineProperty(navigator, "userAgent", {
    value: userAgent,
    configurable: true,
  });
}

function androidIntentQuery(href: string): URLSearchParams {
  return new URLSearchParams(
    href.slice(href.indexOf("?") + 1, href.indexOf("#Intent;")),
  );
}

function androidIntentFallback(href: string): string {
  const encoded = /;S\.browser_fallback_url=([^;]+);end$/.exec(href)?.[1];
  return decodeURIComponent(encoded ?? "");
}

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

mock.module("@/lib/auth/remote-gateway-session", () => ({
  activateRemoteGatewaySession: activateRemoteGatewaySessionMock,
  exchangeRemoteWebPairingToken: exchangeRemoteWebPairingTokenMock,
  // The real parser, not a stand-in: production links carry the device code
  // in the FRAGMENT and in snake_case, which a query-only mock reads as null.
  parseRemoteWebPairingParams,
  remoteGatewayPublicBaseUrl: () => {
    const { origin, pathname } = window.location;
    const match = /\/assistant(?:\/|$)/.exec(pathname);
    const prefix =
      match && match.index > 0
        ? pathname.slice(0, match.index).replace(/\/+$/, "")
        : "";
    return `${origin}${prefix}`;
  },
  RemoteWebPairingError: MockRemoteWebPairingError,
}));

const { RemoteWebPairingPage } =
  await import("@/domains/remote-web/pairing-page");

afterEach(() => {
  cleanup();
  cloudRemote = false;
  injectedAssistantName = undefined;
  injectedHubUrl = undefined;
  nativePlatform = false;
  nativePlatformName = "ios";
  setUserAgent(ORIGINAL_USER_AGENT);
  exchangeRemoteWebPairingTokenMock.mockClear();
  activateRemoteGatewaySessionMock.mockClear();
  nativeSwitchToOriginPathMock.mockReset();
  nativeSwitchToOriginPathMock.mockImplementation(async () => false);
});

describe("RemoteWebPairingPage", () => {
  test("renders NotFound on a cloud remote", () => {
    cloudRemote = true;

    render(
      <MemoryRouter
        initialEntries={["/assistant/pair?deviceCode=device-1&userCode=ABCD"]}
      >
        <RemoteWebPairingPage />
      </MemoryRouter>,
    );

    expect(screen.getByText("Page not found")).not.toBeNull();
    expect(exchangeRemoteWebPairingTokenMock).not.toHaveBeenCalled();
  });

  test("polls for a token in remote-gateway mode", async () => {
    render(
      <MemoryRouter
        initialEntries={["/assistant/pair?deviceCode=device-1&userCode=ABCD"]}
      >
        <RemoteWebPairingPage />
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

  test("cancel leaves the origin for the hub chooser", async () => {
    injectedHubUrl = "https://hub.example.com/assistant";
    const assignMock = mock((_url: string) => {});
    const originalAssign = window.location.assign;
    Object.defineProperty(window.location, "assign", {
      value: assignMock,
      configurable: true,
    });

    try {
      render(
        <MemoryRouter
          initialEntries={["/assistant/pair?deviceCode=device-1&userCode=ABCD"]}
        >
          <RemoteWebPairingPage />
        </MemoryRouter>,
      );

      expect(await screen.findByText("Waiting for approval")).not.toBeNull();
      fireEvent.click(screen.getByText("Cancel"));

      // An in-app navigate would be bounced back here by the remote-gateway
      // pairing guard, so cancelling must cross to the hub's own origin.
      await waitFor(() => {
        expect(assignMock.mock.calls[0]?.[0]).toBe(
          "https://hub.example.com/account/select-assistant",
        );
      });
    } finally {
      Object.defineProperty(window.location, "assign", {
        value: originalAssign,
        configurable: true,
      });
    }
  });

  test("cancel uses the native origin switch when available", async () => {
    injectedHubUrl = "https://hub.example.com/assistant";
    nativePlatform = true;
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
          initialEntries={["/assistant/pair?deviceCode=device-1&userCode=ABCD"]}
        >
          <RemoteWebPairingPage />
        </MemoryRouter>,
      );

      expect(await screen.findByText("Waiting for approval")).not.toBeNull();
      fireEvent.click(screen.getByText("Cancel"));

      await waitFor(() => {
        expect(nativeSwitchToOriginPathMock).toHaveBeenCalledWith(
          null,
          "account/select-assistant",
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

  test("cancel falls back when the native shell lacks path switching", async () => {
    injectedHubUrl = "https://hub.example.com/assistant";
    nativePlatform = true;
    const assignMock = mock((_url: string) => {});
    const originalAssign = window.location.assign;
    Object.defineProperty(window.location, "assign", {
      value: assignMock,
      configurable: true,
    });

    try {
      render(
        <MemoryRouter
          initialEntries={["/assistant/pair?deviceCode=device-1&userCode=ABCD"]}
        >
          <RemoteWebPairingPage />
        </MemoryRouter>,
      );

      expect(await screen.findByText("Waiting for approval")).not.toBeNull();
      fireEvent.click(screen.getByText("Cancel"));

      await waitFor(() => {
        expect(nativeSwitchToOriginPathMock).toHaveBeenCalledWith(
          null,
          "account/select-assistant",
        );
        expect(assignMock.mock.calls[0]?.[0]).toBe(
          "https://hub.example.com/account/select-assistant",
        );
      });
    } finally {
      Object.defineProperty(window.location, "assign", {
        value: originalAssign,
        configurable: true,
      });
    }
  });

  test("cancel is hidden when the served config names no hub", async () => {
    injectedHubUrl = undefined;

    render(
      <MemoryRouter
        initialEntries={["/assistant/pair?deviceCode=device-1&userCode=ABCD"]}
      >
        <RemoteWebPairingPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Waiting for approval")).not.toBeNull();
    expect(screen.queryByText("Cancel")).toBeNull();
  });

  test("asks for a pairing code when opened without one", () => {
    const { container } = render(
      <MemoryRouter initialEntries={["/assistant/pair"]}>
        <RemoteWebPairingPage />
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
      <MemoryRouter initialEntries={["/assistant/pair"]}>
        <RemoteWebPairingPage />
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
        initialEntries={["/assistant/pair?deviceCode=device-1&userCode=ABCD"]}
      >
        <RemoteWebPairingPage />
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
        initialEntries={["/assistant/pair?deviceCode=device-1&userCode=ABCD"]}
      >
        <RemoteWebPairingPage />
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
          "/assistant/pair?deviceCode=fast-code&userCode=WXYZ-1234",
        ]}
      >
        <RemoteWebPairingPage />
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
      <MemoryRouter initialEntries={["/assistant/pair?deviceCode=old-code"]}>
        <RemoteWebPairingPage />
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
        initialEntries={["/assistant/pair?deviceCode=slow-code&userCode=ABCD"]}
      >
        <RemoteWebPairingPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Waiting for approval")).not.toBeNull();
    expect(screen.getByText("ABCD")).not.toBeNull();
    expect(screen.getByText("Pairing code")).not.toBeNull();
  });

  test("clears the device-code fragment from the URL after a successful exchange", async () => {
    exchangeRemoteWebPairingTokenMock.mockImplementationOnce(
      async () => APPROVED_RESULT,
    );
    const replaceStateSpy = mock(
      (_data: unknown, _unused: string, _url?: string | URL | null) => {},
    );
    const originalReplaceState = window.history.replaceState;
    Object.defineProperty(window.history, "replaceState", {
      configurable: true,
      value: replaceStateSpy,
    });

    try {
      render(
        <MemoryRouter initialEntries={["/assistant/pair?deviceCode=fast-code"]}>
          <RemoteWebPairingPage />
        </MemoryRouter>,
      );

      await screen.findByText("Connected");
      expect(replaceStateSpy).toHaveBeenCalled();
      // The replacement URL carries no fragment.
      const clearedWithoutHash = replaceStateSpy.mock.calls.some(
        (call) => !String(call?.[2] ?? "").includes("#"),
      );
      expect(clearedWithoutHash).toBe(true);
    } finally {
      Object.defineProperty(window.history, "replaceState", {
        configurable: true,
        value: originalReplaceState,
      });
    }
  });

  test("offers the app handoff for a device code in an iOS browser without burning the code", async () => {
    setUserAgent(IPHONE_USER_AGENT);

    render(
      <MemoryRouter
        initialEntries={["/assistant/pair?deviceCode=device-1&userCode=ABCD"]}
      >
        <RemoteWebPairingPage />
      </MemoryRouter>,
    );

    const link = await screen.findByRole("link", {
      name: "Open in the Cadet app",
    });
    const href = link.getAttribute("href") ?? "";
    expect(href.startsWith("cadet://connect?")).toBe(true);
    const query = new URLSearchParams(href.slice(href.indexOf("?") + 1));
    expect(query.get("url")).toBe(window.location.origin);
    expect(query.get("code")).toBe("device-1");
    // The served config carries no assistant name, so the link omits it.
    expect(query.has("name")).toBe(false);

    // The single-use code stays unspent while the choice is pending.
    expect(exchangeRemoteWebPairingTokenMock).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Continue in this browser" }),
    ).not.toBeNull();
  });

  test("offers the same app handoff in an Android browser", async () => {
    setUserAgent(ANDROID_USER_AGENT);

    render(
      <MemoryRouter
        initialEntries={[
          "/assistant/pair?deviceCode=android-device&userCode=ABCD",
        ]}
      >
        <RemoteWebPairingPage />
      </MemoryRouter>,
    );

    const link = await screen.findByRole("link", {
      name: "Open in the Cadet app",
    });
    const href = link.getAttribute("href") ?? "";
    expect(href.startsWith("intent://connect?")).toBe(true);
    const intentIndex = href.indexOf("#Intent;");
    const query = androidIntentQuery(href);
    expect(query.get("url")).toBe(window.location.origin);
    expect(query.get("code")).toBe("android-device");
    expect(href.slice(intentIndex)).toContain(
      "#Intent;scheme=cadet;package=ai.mycadet.android;",
    );
    expect(androidIntentFallback(href)).toBe(window.location.href);
    expect(exchangeRemoteWebPairingTokenMock).not.toHaveBeenCalled();
  });

  test("the app handoff url carries the assistant name from the served config", async () => {
    injectedAssistantName = "My Homelab";
    setUserAgent(IPHONE_USER_AGENT);

    render(
      <MemoryRouter
        initialEntries={["/assistant/pair?deviceCode=device-1&userCode=ABCD"]}
      >
        <RemoteWebPairingPage />
      </MemoryRouter>,
    );

    const link = await screen.findByRole("link", {
      name: "Open in the Cadet app",
    });
    const href = link.getAttribute("href") ?? "";
    const query = new URLSearchParams(href.slice(href.indexOf("?") + 1));
    expect(query.get("name")).toBe("My Homelab");
    expect(query.get("code")).toBe("device-1");
    // Spaces are percent-encoded, not form-encoded: iOS URLComponents keeps
    // a raw `+` as a literal plus.
    expect(href).toContain("name=My%20Homelab");
  });

  test("the Android app handoff url carries the assistant name too", async () => {
    injectedAssistantName = "My Homelab";
    setUserAgent(ANDROID_USER_AGENT);

    render(
      <MemoryRouter
        initialEntries={["/assistant/pair?deviceCode=device-1&userCode=ABCD"]}
      >
        <RemoteWebPairingPage />
      </MemoryRouter>,
    );

    const link = await screen.findByRole("link", {
      name: "Open in the Cadet app",
    });
    const href = link.getAttribute("href") ?? "";
    expect(androidIntentQuery(href).get("name")).toBe("My Homelab");
  });

  test("the app handoff url keeps a served path prefix", async () => {
    setUserAgent(IPHONE_USER_AGENT);
    // The real window location carries the served path in production; the
    // in-memory router below only controls the route, not window.location.
    window.history.pushState(null, "", "/assistant-123/assistant/pair");

    try {
      render(
        <MemoryRouter
          initialEntries={["/assistant/pair?deviceCode=device-1&userCode=ABCD"]}
        >
          <RemoteWebPairingPage />
        </MemoryRouter>,
      );

      const link = await screen.findByRole("link", {
        name: "Open in the Cadet app",
      });
      const href = link.getAttribute("href") ?? "";
      const query = new URLSearchParams(href.slice(href.indexOf("?") + 1));
      expect(query.get("url")).toBe(`${window.location.origin}/assistant-123`);
    } finally {
      window.history.pushState(null, "", "/");
    }
  });

  test("the Android app handoff url preserves encoded codes", async () => {
    setUserAgent(ANDROID_USER_AGENT);
    const deviceCode = "code & # / 🚀";
    const pairingQuery = new URLSearchParams({
      deviceCode,
      userCode: "ABCD",
    });

    render(
      <MemoryRouter
        initialEntries={[`/assistant/pair?${pairingQuery.toString()}`]}
      >
        <RemoteWebPairingPage />
      </MemoryRouter>,
    );

    const link = await screen.findByRole("link", {
      name: "Open in the Cadet app",
    });
    const href = link.getAttribute("href") ?? "";
    const query = androidIntentQuery(href);
    expect(query.get("code")).toBe(deviceCode);
  });

  test("exchanges immediately for a device code in a desktop browser", async () => {
    // The default happy-dom user agent is a desktop browser.

    render(
      <MemoryRouter
        initialEntries={["/assistant/pair?deviceCode=device-1&userCode=ABCD"]}
      >
        <RemoteWebPairingPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(exchangeRemoteWebPairingTokenMock.mock.calls[0]?.[0]).toBe(
        "device-1",
      );
    });
    expect(
      screen.queryByRole("link", { name: "Open in the Cadet app" }),
    ).toBeNull();
  });

  test("keeps browser pairing available when an app handoff fails", async () => {
    setUserAgent(ANDROID_USER_AGENT);
    window.history.pushState(
      null,
      "",
      "/assistant/pair?deviceCode=device-1&userCode=ABCD",
    );

    try {
      render(
        <MemoryRouter
          initialEntries={["/assistant/pair?deviceCode=device-1&userCode=ABCD"]}
        >
          <RemoteWebPairingPage />
        </MemoryRouter>,
      );

      const link = await screen.findByRole("link", {
        name: "Open in the Cadet app",
      });
      const href = link.getAttribute("href") ?? "";
      expect(androidIntentFallback(href)).toBe(window.location.href);

      const continueButton = screen.getByRole("button", {
        name: "Continue in this browser",
      });
      expect(exchangeRemoteWebPairingTokenMock).not.toHaveBeenCalled();

      fireEvent.click(continueButton);

      await waitFor(() => {
        expect(exchangeRemoteWebPairingTokenMock.mock.calls[0]?.[0]).toBe(
          "device-1",
        );
      });
      expect(
        screen.queryByRole("link", { name: "Open in the Cadet app" }),
      ).toBeNull();
    } finally {
      window.history.pushState(null, "", "/");
    }
  });

  test.each([
    ["iOS", "ios", IPHONE_USER_AGENT],
    ["Android", "android", ANDROID_USER_AGENT],
  ] as const)(
    "skips the app handoff inside the native %s shell",
    async (_, platform, userAgent) => {
      setUserAgent(userAgent);
      nativePlatform = true;
      nativePlatformName = platform;

      render(
        <MemoryRouter
          initialEntries={["/assistant/pair?deviceCode=device-1&userCode=ABCD"]}
        >
          <RemoteWebPairingPage />
        </MemoryRouter>,
      );

      await waitFor(() => {
        expect(exchangeRemoteWebPairingTokenMock.mock.calls[0]?.[0]).toBe(
          "device-1",
        );
      });
      expect(
        screen.queryByRole("link", { name: "Open in the Cadet app" }),
      ).toBeNull();
    },
  );
});
