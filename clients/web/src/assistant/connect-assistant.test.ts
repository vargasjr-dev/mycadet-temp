import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { cleanup } from "@testing-library/react";

import { setSelfHostedConnection } from "@/lib/self-hosted/connection";

let sessionUser: MockSessionUser | null = null;

type MockSessionUser = {
  id?: string;
  username?: string;
  email?: string;
};

let mockIsLocalClient = false;
// The assistant `getActiveAssistant()` resolves; `undefined` means none selected.
let mockSelectedAssistant:
  | {
      assistantId: string;
      cloud: string;
      runtimeUrl?: string;
    }
  | undefined;
let mockLockfileAssistants: Array<{
  assistantId: string;
  cloud: string;
  runtimeUrl?: string;
}> = [];
let mockPrimeError: Error | null = null;
const setSelectedAssistantMock = mock(async (_id: string | null) => {});
const primeLocalGatewayConnectionMock = mock(
  async (_target?: { assistantId: string; cloud: string }) => {
    if (mockPrimeError) {
      throw mockPrimeError;
    }
  },
);
const primeLocalGatewayConnectionWithStartupRetryMock = mock(async () => {
  if (mockPrimeError) {
    throw mockPrimeError;
  }
});
const primeLocalGatewayConnectionWithRepairMock = mock(async () => {
  if (mockPrimeError) {
    throw mockPrimeError;
  }
});
const bootstrapLocalAssistantCloudIdentityMock = mock(
  (_assistantId?: string) => {},
);

// The real predicate, applied against the contract helpers directly: the
// paired-connect tests seed `cloud: "local"` + an off-machine runtimeUrl,
// which is exactly what makes an entry a paired target.
import {
  isLoopbackGatewayCloud,
  isUsableRuntimeUrl,
} from "@mycadet/local-mode/contract";
const isRemoteGatewayEntryMock = (entry: {
  cloud: Parameters<typeof isLoopbackGatewayCloud>[0];
  runtimeUrl?: string;
}): boolean =>
  isLoopbackGatewayCloud(entry.cloud) &&
  isUsableRuntimeUrl(entry.runtimeUrl);

mock.module("@/lib/auth/allauth-client", () => ({
  getSession: async () => {
    if (!sessionUser) {
      return {
        ok: false,
        status: 401,
        error: { detail: "Unauthorized" },
      };
    }
    return { ok: true, data: { user: sessionUser } };
  },
  logout: async () => {},
}));

mock.module("@/lib/local-mode", () => ({
  isLocalClient: () => mockIsLocalClient,
  isLocalAssistant: (a: { cloud?: string }) => a.cloud === "local",
  isCloudAssistant: (a: { cloud?: string }) => a.cloud === "cadet",
  isCadetCloudRemote: () => false,
  isServedGatewayRuntime: () => false,
  hasPairedGateway: (
    a: { assistantId: string; runtimeUrl?: string } | undefined,
  ) => !!a && !!a.runtimeUrl,
  hasLocalGateway: (
    a: { assistantId: string; runtimeUrl?: string } | undefined,
  ) => !!a && !a.runtimeUrl,
  getCloudAssistants: () => [],
  getLocalAssistants: () =>
    mockSelectedAssistant ? [mockSelectedAssistant] : [],
  getActiveAssistant: () => mockSelectedAssistant,
  getServedLockfile: () => ({ assistants: [], activeAssistant: null }),
  getLockfileAssistant: (id: string) =>
    mockLockfileAssistants.find((a) => a.assistantId === id),
  isRemoteGatewayEntry: isRemoteGatewayEntryMock,
  primeLocalGatewayConnection: primeLocalGatewayConnectionMock,
  primeLocalGatewayConnectionWithStartupRetry:
    primeLocalGatewayConnectionWithStartupRetryMock,
  primeLocalGatewayConnectionWithRepair:
    primeLocalGatewayConnectionWithRepairMock,
}));

mock.module("@/lib/auth/remote-gateway-session", () => ({
  remoteGatewayPublicPathPrefix: () => "",
  remoteGatewayPublicBaseUrl: () => "",
}));

mock.module("@/lib/local-cloud-identity", () => ({
  bootstrapLocalAssistantCloudIdentity:
    bootstrapLocalAssistantCloudIdentityMock,
  resolveLocalAssistantCloudIdentity: async (id: string) => id,
  fetchCloudStatus: async () => null,
  isUuid: (value: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    ),
}));

mock.module("@/runtime/native-auth", () => ({
  isNativePlatform: () => false,
  isOAuthFlowInFlight: () => false,
  installSessionCookies: () => {},
  waitForNativeSessionCookie: async () => {},
}));

mock.module("@/runtime/native-biometric", () => ({
  deleteBiometricToken: async () => {},
  isBiometricEnabled: () => false,
  setBiometricEnabled: (_enabled: boolean) => {},
  storeBiometricToken: async () => false,
  retrieveBiometricToken: async () => null,
  getBiometricCapability: async () => null,
}));

// Full module surface: `mock.module` is process-global in bun, so a partial
// shape would shadow the other exports for later test files.
mock.module("@/runtime/widget-snapshot", () => ({
  WIDGET_SNAPSHOT_SCHEMA_VERSION: 2,
  isWidgetSnapshotSyncAvailable: () => false,
  readWidgetSnapshotAssistantId: () => null,
  syncWidgetSnapshot: async () => false,
  clearWidgetSnapshot: async () => true,
  retryPendingWidgetSnapshotClear: async () => true,
}));

// The connect flow writes the selection through the public wrapper, not the
// store action — mock the wrapper module so the real one (and its
// local-mode deps) never loads.
mock.module("@/assistant/selection", () => ({
  setSelectedAssistant: setSelectedAssistantMock,
}));

// Don't mock `@/lib/event-bus` — bun's `mock.module` is process-global, so
// any stub here would shadow the real bus for every later test file in the
// run.

const { connectCloudAssistant, connectLocalAssistant, connectPairedAssistant } =
  await import("@/assistant/connect-assistant");

beforeEach(() => {
  sessionUser = null;
  setSelfHostedConnection(null);
  mockIsLocalClient = false;
  mockSelectedAssistant = undefined;
  mockLockfileAssistants = [];
  mockPrimeError = null;
  setSelectedAssistantMock.mockClear();
  primeLocalGatewayConnectionMock.mockClear();
  primeLocalGatewayConnectionWithStartupRetryMock.mockClear();
  primeLocalGatewayConnectionWithRepairMock.mockClear();
  bootstrapLocalAssistantCloudIdentityMock.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("connectLocalAssistant", () => {
  test("primes the connection BEFORE selecting the assistant", async () => {
    mockIsLocalClient = true;
    // Prime must complete before the selection write becomes observable —
    // the lifecycle's selection subscription republishes the connection
    // synchronously on the write, with whatever token is cached.
    const order: string[] = [];
    primeLocalGatewayConnectionWithRepairMock.mockImplementationOnce(
      async () => {
        order.push("prime");
      },
    );
    setSelectedAssistantMock.mockImplementationOnce(async (id) => {
      order.push(`select:${String(id)}`);
    });

    await connectLocalAssistant("local-a");

    expect(order).toEqual(["prime", "select:local-a"]);
  });

  test("bootstraps the connected local assistant's cloud identity", async () => {
    mockIsLocalClient = true;

    await connectLocalAssistant("local-a");

    expect(bootstrapLocalAssistantCloudIdentityMock).toHaveBeenCalledTimes(1);
    expect(bootstrapLocalAssistantCloudIdentityMock).toHaveBeenCalledWith(
      "local-a",
    );
  });

  test("rethrows the prime failure without selecting or bootstrapping", async () => {
    mockIsLocalClient = true;
    mockPrimeError = new Error("Guardian token not found");

    await expect(connectLocalAssistant("local-a")).rejects.toThrow(
      "Guardian token not found",
    );

    expect(setSelectedAssistantMock).not.toHaveBeenCalled();
    expect(bootstrapLocalAssistantCloudIdentityMock).not.toHaveBeenCalled();
  });
});

describe("connectPairedAssistant", () => {
  // The modern connect import: the entry is a canonical custom remote — the
  // contract classifier's paired shape.
  const pairedEntry = {
    assistantId: "paired-a",
    cloud: "custom",
    ipAddress: "gw.example.com",
    port: 443,
  };

  test("primes the host proxy before selecting", async () => {
    mockIsLocalClient = true;
    mockLockfileAssistants = [pairedEntry];
    const order: string[] = [];
    primeLocalGatewayConnectionMock.mockImplementationOnce(async () => {
      order.push("prime");
    });
    setSelectedAssistantMock.mockImplementationOnce(async (id) => {
      order.push(`select:${String(id)}`);
    });

    await connectPairedAssistant("paired-a");

    expect(order).toEqual(["prime", "select:paired-a"]);
  });

  test("uses the plain prime for the paired target: no wake-repair variant", async () => {
    // Wake only runs inside primeLocalGatewayConnectionWithRepair, and it
    // cannot start or repair an assistant on a remote machine, so a paired
    // connect must stay on the plain prime.
    mockIsLocalClient = true;
    mockLockfileAssistants = [pairedEntry];

    await connectPairedAssistant("paired-a");

    expect(primeLocalGatewayConnectionMock).toHaveBeenCalledTimes(1);
    expect(primeLocalGatewayConnectionMock).toHaveBeenCalledWith(
      expect.objectContaining({ assistantId: "paired-a", cloud: "custom" }),
    );
    expect(primeLocalGatewayConnectionWithRepairMock).not.toHaveBeenCalled();
    expect(
      primeLocalGatewayConnectionWithStartupRetryMock,
    ).not.toHaveBeenCalled();
  });

  test("never bootstraps a cloud identity", async () => {
    // The bootstrap registers a LOCAL assistant with the cloud; a paired
    // entry is a client-side pairing record, not an assistant to register.
    mockIsLocalClient = true;
    mockLockfileAssistants = [pairedEntry];

    await connectPairedAssistant("paired-a");

    expect(bootstrapLocalAssistantCloudIdentityMock).not.toHaveBeenCalled();
  });

  test("rejects a non-paired id without priming or selecting", async () => {
    mockIsLocalClient = true;
    mockLockfileAssistants = [{ assistantId: "local-a", cloud: "local" }];

    await expect(connectPairedAssistant("local-a")).rejects.toThrow(
      "Not a paired assistant",
    );

    expect(primeLocalGatewayConnectionMock).not.toHaveBeenCalled();
    expect(setSelectedAssistantMock).not.toHaveBeenCalled();
  });

  test("rejects an unknown id", async () => {
    mockIsLocalClient = true;
    mockLockfileAssistants = [pairedEntry];

    await expect(connectPairedAssistant("missing")).rejects.toThrow(
      "Not a paired assistant",
    );

    expect(primeLocalGatewayConnectionMock).not.toHaveBeenCalled();
  });

  test("rethrows the prime failure without selecting", async () => {
    mockIsLocalClient = true;
    mockLockfileAssistants = [pairedEntry];
    mockPrimeError = new Error("Guardian token not found");

    await expect(connectPairedAssistant("paired-a")).rejects.toThrow(
      "Guardian token not found",
    );

    expect(setSelectedAssistantMock).not.toHaveBeenCalled();
  });
});

describe("connectCloudAssistant", () => {
  test("requires a live platform session", async () => {
    sessionUser = null;

    await expect(connectCloudAssistant("cloud-1")).rejects.toThrow(
      "Platform authentication required",
    );
    expect(setSelectedAssistantMock).not.toHaveBeenCalled();
  });

  test("selects the assistant when the session is live", async () => {
    sessionUser = { id: "user-1", email: "user@example.com" };

    await connectCloudAssistant("cloud-1");

    expect(setSelectedAssistantMock).toHaveBeenCalledWith("cloud-1");
    expect(bootstrapLocalAssistantCloudIdentityMock).not.toHaveBeenCalled();
  });
});
