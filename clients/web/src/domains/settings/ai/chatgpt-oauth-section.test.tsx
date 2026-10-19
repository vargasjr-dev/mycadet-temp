/**
 * Tests for the ChatGPT subscription sign-in section.
 *
 * The redirect-and-paste flow is the whole section: no code is minted, no
 * disclosure is offered, and the flow wears the plain sign-in name.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { cleanup, render, screen } from "@testing-library/react";

import type { ProviderConnection } from "@/generated/daemon/types.gen";
import type { PollOutcome } from "@/utils/poll-until-settled";

const ASSISTANT_ID = "asst-1";

const actualApi = await import(
  "@/domains/settings/ai/chatgpt-subscription-api"
);
const { CHATGPT_ACCESS_TOKEN_CREDENTIAL, DeviceAuthUnsupportedError } =
  actualApi;

const STORED_CONNECTION: ProviderConnection = {
  name: "chatgpt-subscription",
  provider: "chatgpt",
  auth: {
    type: "oauth_subscription",
    credential: CHATGPT_ACCESS_TOKEN_CREDENTIAL,
  },
  label: "ChatGPT Subscription",
  baseUrl: null,
  models: null,
  createdAt: 0,
  updatedAt: 0,
  isManaged: false,
};

let startShouldFail = false;
/** The daemon answers the mint route with a 404. */
let startUnsupported = false;
let startCalls = 0;
/** States the section asked the daemon to stop polling. */
let cancelledStates: string[] = [];
/** How the scripted flow settles. `never` leaves it pending on screen. */
let settle: PollOutcome | "never" = { kind: "connected" };

mock.module("@/domains/settings/ai/chatgpt-subscription-api", () => ({
  ...actualApi,
  startChatgptDeviceAuth: async () => {
    startCalls++;
    if (startUnsupported) {
      throw new DeviceAuthUnsupportedError();
    }
    if (startShouldFail) {
      throw new Error("start failed");
    }
    return {
      state: "state-abc",
      userCode: "ABCD-1234",
      verificationUrl: "https://chatgpt.com/device",
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      intervalSeconds: 5,
    };
  },
  pollChatgptDeviceAuthStatus: async () => ({ status: "pending" }),
  cancelChatgptDeviceAuth: async (_assistantId: string, state: string) => {
    cancelledStates.push(state);
  },
  resolveChatgptConnection: async () => STORED_CONNECTION,
}));

// The loop's own cadence and budget are covered in
// `utils/poll-until-settled.test.ts`; here it stands in for whichever way the
// flow settled so the section's rendering is what is under test.
mock.module("@/utils/poll-until-settled", () => ({
  pollUntilSettled: (): Promise<PollOutcome> =>
    settle === "never" ? new Promise(() => {}) : Promise.resolve(settle),
}));

const { ChatgptOAuthSection } = await import(
  "@/domains/settings/ai/chatgpt-oauth-section"
);

function renderSection(onConnected: (c: ProviderConnection) => void = () => {}) {
  return render(
    <ChatgptOAuthSection
      assistantId={ASSISTANT_ID}
      onConnected={onConnected}
    />,
  );
}

describe("ChatgptOAuthSection", () => {
  beforeEach(() => {
    startShouldFail = false;
    startUnsupported = false;
    startCalls = 0;
    cancelledStates = [];
    settle = { kind: "connected" };
  });

  afterEach(() => {
    cleanup();
  });

  test("the paste flow is the whole section", () => {
    renderSection();

    expect(
      screen.getByText(
        "3. Copy the full URL from that page's address bar and paste it below",
      ),
    ).toBeDefined();
    expect(screen.queryByText("Other sign-in options")).toBeNull();
    expect(screen.queryByText("Hide other sign-in options")).toBeNull();
    expect(startCalls).toBe(0);
  });

  // The flow is the section's only sign-in, so it carries the plain
  // "Sign in with ChatGPT" name throughout.
  test("wears the plain sign-in name", () => {
    renderSection();

    expect(screen.getByText("Sign in with ChatGPT")).toBeDefined();
    expect(
      screen.getByText('1. Click "Sign in with ChatGPT" below to open a popup'),
    ).toBeDefined();
    expect(screen.queryByText("Open ChatGPT sign-in")).toBeNull();
    expect(
      screen.queryByText(
        '1. Click "Open ChatGPT sign-in" below to open a popup',
      ),
    ).toBeNull();
  });
});
