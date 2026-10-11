import { afterEach, beforeEach, describe, test, expect, mock } from "bun:test";
import { setTunnelBridgeAuthHeader } from "../tunnel/bridge-auth.js";
import { getLogger } from "../logger.js";
import {
  GUARDIAN_PRINCIPAL,
  TUNNEL_USER_ID,
  makeConfig,
  mintEdgeToken,
  mintServiceEdgeToken,
} from "./runtime-stream-test-utils.js";

// Both lookups are mocked BEFORE the module under test is imported, so the
// pin is testable without gateway DB state.
let mockFindCadetGuardian = mock(
  async (): Promise<{ principalId: string } | null> => ({
    principalId: GUARDIAN_PRINCIPAL,
  }),
);
mock.module("../auth/guardian-bootstrap.js", () => ({
  findCadetGuardian: () => mockFindCadetGuardian(),
}));

let mockReadCredential = mock(
  async (_key: string): Promise<string | undefined> => TUNNEL_USER_ID,
);
mock.module("../cloud-user-id.js", () => ({
  readStoredCloudUserId: async () => ({
    userId: await mockReadCredential("cadet:platform_user_id"),
    unreachable: false,
  }),
}));

const { authorizeGuardianStream } =
  await import("../http/routes/guardian-pin.js");

const log = getLogger("guardian-pin-test");
const STREAM_URL = "http://localhost:7830/v1/watch/stream";

beforeEach(() => {
  mockFindCadetGuardian = mock(async () => ({
    principalId: GUARDIAN_PRINCIPAL,
  }));
  mockReadCredential = mock(async (_key: string) => TUNNEL_USER_ID);
});

afterEach(() => {
  delete process.env.IS_CLOUD;
});

/**
 * The proxies replace the caller's identity with a service token upstream, so
 * the daemon cannot tell one actor from another: whoever this gate admits is
 * treated as the owner. This is the only place a non-guardian can be refused.
 */
describe("authorizeGuardianStream: the actor token path", () => {
  const authorize = (token?: string, config = makeConfig()) =>
    authorizeGuardianStream(
      new Request(token ? `${STREAM_URL}?token=${token}` : STREAM_URL, {
        headers: { upgrade: "websocket" },
      }),
      config,
      log,
    );

  test("admits the bound guardian", async () => {
    expect(await authorize(mintEdgeToken(GUARDIAN_PRINCIPAL))).toBeNull();
  });

  test("refuses a valid actor token that is not the bound guardian", async () => {
    const res = await authorize(mintEdgeToken("someone-else"));

    expect(res!.status).toBe(403);
  });

  test("refuses when no guardian binding exists", async () => {
    mockFindCadetGuardian = mock(async () => null);

    const res = await authorize(mintEdgeToken(GUARDIAN_PRINCIPAL));

    expect(res!.status).toBe(403);
  });

  /**
   * A lookup that throws leaves the answer unknown. Reporting that as
   * "forbidden" would misread a database problem as a permission one.
   */
  test("answers 503 when the binding lookup fails", async () => {
    mockFindCadetGuardian = mock(async () => {
      throw new Error("db down");
    });

    const res = await authorize(mintEdgeToken(GUARDIAN_PRINCIPAL));

    expect(res!.status).toBe(503);
  });

  test("returns 401 when no token is provided", async () => {
    const res = await authorize();

    expect(res!.status).toBe(401);
    expect(mockFindCadetGuardian).not.toHaveBeenCalled();
  });

  test("returns 401 for a service token, which has no actor principal", async () => {
    const res = await authorize(mintServiceEdgeToken());

    expect(res!.status).toBe(401);
  });

  test("returns 426 when the request is not a WebSocket upgrade", async () => {
    const res = await authorizeGuardianStream(
      new Request(`${STREAM_URL}?token=${mintEdgeToken()}`),
      makeConfig(),
      log,
    );

    expect(res!.status).toBe(426);
  });

  /** The dev bypass validates no token, so there is no principal to pin. */
  test("admits an unauthenticated caller when auth is disabled", async () => {
    const res = await authorize(
      undefined,
      makeConfig({ runtimeProxyRequireAuth: false }),
    );

    expect(res).toBeNull();
    expect(mockFindCadetGuardian).not.toHaveBeenCalled();
  });
});

/**
 * The cloud path, where tunnel validated the browser's token and injected the
 * caller. The attestation proves the caller is *a* platform user who traversed
 * tunnel, not that they are this assistant's guardian, so it is cross-checked
 * against the stored `platform_user_id`.
 */
describe("authorizeGuardianStream: the tunnel-attested managed path", () => {
  const TUNNEL_ORG_ID = "22222222-2222-2222-2222-222222222222";

  const managedAuthorize = ({
    userId = TUNNEL_USER_ID,
    actor = "user",
    orgId = TUNNEL_ORG_ID as string | null,
    bridgeProof = true,
    token,
    managed = true,
    upgrade = true,
    tunnelBaseUrl,
  }: {
    userId?: string;
    actor?: string;
    orgId?: string | null;
    bridgeProof?: boolean;
    token?: string;
    managed?: boolean;
    upgrade?: boolean;
    tunnelBaseUrl?: string;
  }) => {
    if (managed) {
      process.env.IS_CLOUD = "true";
    } else {
      delete process.env.IS_CLOUD;
    }
    const headers = new Headers({
      "x-tunnel-user-id": userId,
      "x-tunnel-actor": actor,
    });
    if (upgrade) {
      headers.set("upgrade", "websocket");
    }
    if (orgId !== null) {
      headers.set("x-tunnel-org-id", orgId);
    }
    if (bridgeProof) {
      setTunnelBridgeAuthHeader(headers);
    }
    const query = token ? `?token=${token}` : "";
    return authorizeGuardianStream(
      new Request(`${STREAM_URL}${query}`, { headers }),
      makeConfig({ tunnelBaseUrl }),
      log,
    );
  };

  test("admits an attested caller who is the bound guardian", async () => {
    expect(await managedAuthorize({})).toBeNull();
  });

  test("refuses an attested caller who is not the bound guardian", async () => {
    mockReadCredential = mock(
      async () => "99999999-9999-9999-9999-999999999999",
    );

    const res = await managedAuthorize({});

    expect(res!.status).toBe(403);
  });

  test("refuses when this assistant has no platform user stored", async () => {
    mockReadCredential = mock(async () => undefined);

    const res = await managedAuthorize({});

    expect(res!.status).toBe(403);
  });

  test("answers 503 when the cloud user lookup fails", async () => {
    mockReadCredential = mock(async () => {
      throw new Error("credential store down");
    });

    const res = await managedAuthorize({});

    expect(res!.status).toBe(503);
  });

  /**
   * A direct request to a reachable gateway can spoof the header names. It
   * cannot know the process-local bridge proof, which is what says the request
   * really arrived through this gateway's own loopback bridge.
   */
  test("ignores spoofed tunnel headers with no bridge proof", async () => {
    const res = await managedAuthorize({ bridgeProof: false });

    expect(res!.status).toBe(401);
    expect(mockReadCredential).not.toHaveBeenCalled();
  });

  test("falls through to the token path on an incomplete attestation", async () => {
    const res = await managedAuthorize({
      orgId: null,
      token: mintEdgeToken(GUARDIAN_PRINCIPAL),
    });

    expect(res).toBeNull();
  });

  /** Falling through must not fall past the pin. */
  test("still pins the token path in managed mode", async () => {
    const res = await managedAuthorize({
      actor: "service",
      token: mintEdgeToken("someone-else"),
    });

    expect(res!.status).toBe(403);
  });

  test("does not trust tunnel headers on a gateway with no tunnel", async () => {
    const res = await managedAuthorize({ managed: false });

    expect(res!.status).toBe(401);
  });

  test("admits the attested guardian through a locally hosted tunnel", async () => {
    expect(
      await managedAuthorize({
        managed: false,
        tunnelBaseUrl: "https://tunnel.example.test",
      }),
    ).toBeNull();
  });

  test("refuses a different owner through a locally hosted tunnel", async () => {
    const res = await managedAuthorize({
      managed: false,
      tunnelBaseUrl: "https://tunnel.example.test",
      userId: "99999999-9999-9999-9999-999999999999",
    });
    expect(res!.status).toBe(403);
  });

  test("requires bridge proof through a locally hosted tunnel", async () => {
    const res = await managedAuthorize({
      managed: false,
      tunnelBaseUrl: "https://tunnel.example.test",
      bridgeProof: false,
    });
    expect(res!.status).toBe(401);
  });

  /**
   * The cloud path skips the shared gate, so the upgrade header is checked
   * before it: a plain managed request must get 426, not a failed upgrade.
   */
  test("answers 426 for a plain request even when tunnel attests the guardian", async () => {
    const res = await managedAuthorize({ upgrade: false });

    expect(res!.status).toBe(426);
    expect(mockReadCredential).not.toHaveBeenCalled();
  });
});
