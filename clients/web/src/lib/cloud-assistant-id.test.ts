import { beforeEach, describe, expect, mock, test } from "bun:test";

const PLATFORM_ASSISTANT_ID = "11111111-1111-4111-8111-111111111111";

const resolveLocalAssistantCloudIdentityMock = mock(
  async (assistantId: string) => assistantId,
);
const fetchCloudStatusMock = mock(
  async (): Promise<{ assistantId: string } | null> => null,
);
let cloudRemote = false;
let remoteGatewayBaseUrl = "https://gateway.example.com";

mock.module("@/lib/auth/remote-gateway-session", () => ({
  remoteGatewayPublicBaseUrl: () => remoteGatewayBaseUrl,
}));
mock.module("@/lib/local-cloud-identity", () => ({
  isUuid: (value: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    ),
  resolveLocalAssistantCloudIdentity: resolveLocalAssistantCloudIdentityMock,
  fetchCloudStatus: fetchCloudStatusMock,
}));
/** The paired lockfile entry the private paired leg resolves against. */
let mockPairedEntry: {
  assistantId: string;
  cloud: string;
  runtimeUrl: string;
} | null = null;
mock.module("@/lib/local-mode", () => ({
  isCadetCloudRemote: () => cloudRemote,
  getLockfileAssistant: (id: string) =>
    mockPairedEntry && mockPairedEntry.assistantId === id
      ? mockPairedEntry
      : null,
  hasPairedGateway: (entry: { runtimeUrl?: string } | null) =>
    !!entry?.runtimeUrl,
}));
mock.module("@/lib/self-hosted/connection", () => ({
  getSelfHostedActorToken: () => "actor-token",
}));

const { resolveCloudAssistantId } = await import("@/lib/cloud-assistant-id");

beforeEach(() => {
  cloudRemote = false;
  remoteGatewayBaseUrl = "https://gateway.example.com";
  resolveLocalAssistantCloudIdentityMock.mockClear();
  resolveLocalAssistantCloudIdentityMock.mockImplementation(
    async (assistantId: string) => assistantId,
  );
  fetchCloudStatusMock.mockClear();
  fetchCloudStatusMock.mockImplementation(async () => null);
  mockPairedEntry = null;
});

describe("resolveCloudAssistantId", () => {
  test("returns a UUID unchanged", async () => {
    await expect(resolveCloudAssistantId(PLATFORM_ASSISTANT_ID)).resolves.toBe(
      PLATFORM_ASSISTANT_ID,
    );
    expect(resolveLocalAssistantCloudIdentityMock).not.toHaveBeenCalled();
  });

  test("resolves a lockfile slug through local platform identity", async () => {
    resolveLocalAssistantCloudIdentityMock.mockImplementationOnce(
      async () => PLATFORM_ASSISTANT_ID,
    );

    await expect(resolveCloudAssistantId("local-slug")).resolves.toBe(
      PLATFORM_ASSISTANT_ID,
    );
  });

  test("falls through to the paired lookup when local identity is not a UUID", async () => {
    mockPairedEntry = {
      assistantId: "paired-slug",
      cloud: "local",
      runtimeUrl: "https://gw.example.com",
    };
    fetchCloudStatusMock.mockImplementationOnce(async () => ({
      assistantId: PLATFORM_ASSISTANT_ID,
    }));

    await expect(resolveCloudAssistantId("paired-slug")).resolves.toBe(
      PLATFORM_ASSISTANT_ID,
    );
  });

  test("takes the registered id off an injection failure", async () => {
    const { CloudIdentityInjectionError } =
      await import("@/lib/cloud-identity-errors");
    resolveLocalAssistantCloudIdentityMock.mockImplementationOnce(async () => {
      throw new CloudIdentityInjectionError(
        PLATFORM_ASSISTANT_ID,
        new Error("store unreadable"),
      );
    });

    await expect(resolveCloudAssistantId("local-slug")).resolves.toBe(
      PLATFORM_ASSISTANT_ID,
    );
  });

  test("continues after a local-identity throw", async () => {
    resolveLocalAssistantCloudIdentityMock.mockImplementationOnce(async () => {
      throw new Error("no lockfile");
    });
    mockPairedEntry = {
      assistantId: "paired-slug",
      cloud: "local",
      runtimeUrl: "https://gw.example.com",
    };
    fetchCloudStatusMock.mockImplementationOnce(async () => ({
      assistantId: PLATFORM_ASSISTANT_ID,
    }));

    await expect(resolveCloudAssistantId("paired-slug")).resolves.toBe(
      PLATFORM_ASSISTANT_ID,
    );
  });

  test("resolves remote-gateway 'self' through platform status", async () => {
    fetchCloudStatusMock.mockImplementationOnce(async () => ({
      assistantId: PLATFORM_ASSISTANT_ID,
    }));

    await expect(resolveCloudAssistantId("self")).resolves.toBe(
      PLATFORM_ASSISTANT_ID,
    );
    expect(resolveLocalAssistantCloudIdentityMock).toHaveBeenCalledWith(
      "self",
      { allowGatewayRepair: false },
    );
    expect(fetchCloudStatusMock).toHaveBeenCalledWith(
      {
        gatewayUrl: "https://gateway.example.com",
        actorToken: "actor-token",
      },
      "self",
    );
  });

  test("probes platform status through a prefix-served remote-gateway base", async () => {
    remoteGatewayBaseUrl = "https://gateway.example.com/assistant-123";
    fetchCloudStatusMock.mockImplementationOnce(async () => ({
      assistantId: PLATFORM_ASSISTANT_ID,
    }));

    await expect(resolveCloudAssistantId("self")).resolves.toBe(
      PLATFORM_ASSISTANT_ID,
    );
    expect(fetchCloudStatusMock).toHaveBeenCalledWith(
      {
        gatewayUrl: "https://gateway.example.com/assistant-123",
        actorToken: "actor-token",
      },
      "self",
    );
  });

  test("returns null when no platform UUID can be resolved", async () => {
    await expect(resolveCloudAssistantId("self")).resolves.toBeNull();
  });
});
