import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { LockfileAssistant } from "@/lib/local-mode";

const isLocalClientMock = mock(() => true);
const hasAssistantsMock = mock(() => false);
let mockSelectedAssistant: LockfileAssistant | undefined;
let mockGatewayTokenPresent = false;

// Spread the real module so the resolvers the route fork pulls in
// (`getActiveAssistant`/`isLocalAssistant`/…) stay available; override only
// the hosting-mode flags and the selected-assistant resolver per case.
const localModeActual = await import("@/lib/local-mode");
mock.module("@/lib/local-mode", () => ({
  ...localModeActual,
  isLocalClient: isLocalClientMock,
  hasAssistants: hasAssistantsMock,
  getActiveAssistant: () => mockSelectedAssistant,
  isLocalAssistant: (a: {
    cloud?: string;
    resources?: { gatewayPort?: number };
  }) => a.cloud !== "cadet" && a.resources?.gatewayPort != null,
  isCadetCloudRemote: () => false,
  getSelfHostedActorToken: () => (mockGatewayTokenPresent ? "gw-token" : null),
}));

const { authMiddleware } = await import("./auth-middleware");
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { routes } from "@/utils/routes";

const localAssistant: LockfileAssistant = {
  assistantId: "local-a",
  cloud: "local",
  resources: { gatewayPort: 51234, daemonPort: 51235 },
};

/**
 * Run the middleware and report whether it admitted (called `next`) or threw a
 * redirect Response — so admit-path assertions don't have to special-case the
 * thrown-Response contract.
 */
async function runMiddlewareOutcome(
  pathname: string,
): Promise<{ admitted: true } | { admitted: false; response: Response }> {
  const args = {
    request: new Request(`http://localhost${pathname}`),
    context: { set: () => {}, get: () => null },
  } as unknown as Parameters<typeof authMiddleware>[0];
  const next = (async () => new Response()) as Parameters<
    typeof authMiddleware
  >[1];
  try {
    await authMiddleware(args, next);
    return { admitted: true };
  } catch (thrown) {
    if (thrown instanceof Response) {
      return { admitted: false, response: thrown };
    }
    throw thrown;
  }
}

beforeEach(() => {
  isLocalClientMock.mockImplementation(() => true);
  hasAssistantsMock.mockImplementation(() => false);
  mockSelectedAssistant = undefined;
  mockGatewayTokenPresent = false;
  useResolvedAssistantsStore.setState({
    assistants: [],
    activeAssistantId: null,
  });
});

describe("authMiddleware", () => {
  test("an empty local client is hard-navigated to the hosting funnel", async () => {
    // The hosting fork targets the app bundle — a full-page navigation, so
    // the middleware admits and the page URL carries it.
    const outcome = await runMiddlewareOutcome(routes.identity);
    expect(outcome.admitted).toBe(true);
    expect(window.location.href.endsWith(routes.onboarding.hosting)).toBe(true);
  });

  test("a platform client with an empty roster is hard-navigated to shell hatching", async () => {
    isLocalClientMock.mockImplementation(() => false);

    const outcome = await runMiddlewareOutcome(routes.identity);
    expect(outcome.admitted).toBe(true);
    expect(window.location.href.endsWith(routes.onboarding.hatching)).toBe(
      true,
    );
  });

  test("provisioning entries are admitted", async () => {
    for (const pathname of [
      `${routes.onboarding.research}?hosting=cadet-cloud`,
      routes.onboarding.hatching,
    ]) {
      for (const local of [false, true]) {
        isLocalClientMock.mockImplementation(() => local);
        const href = window.location.href;
        const outcome = await runMiddlewareOutcome(pathname);
        expect(outcome.admitted).toBe(true);
        expect(window.location.href).toBe(href);
      }
    }
  });

  test("a local user with assistants and a reachable gateway is admitted", async () => {
    hasAssistantsMock.mockImplementation(() => true);
    mockSelectedAssistant = localAssistant;
    mockGatewayTokenPresent = true;
    useResolvedAssistantsStore.setState({
      assistants: [localAssistant] as never[],
      activeAssistantId: localAssistant.assistantId,
    });

    const outcome = await runMiddlewareOutcome(routes.identity);
    expect(outcome.admitted).toBe(true);
  });
});
