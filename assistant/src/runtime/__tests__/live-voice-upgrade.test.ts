import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { RuntimeHttpServer } from "../http-server.js";
import {
  actorIdentityHeaders,
  gatewayIdentityHeaders,
  requireHttpAuth,
  upgradeHeaders,
} from "./runtime-ws-test-utils.js";

describe("Live voice through the shared runtime upgrade", () => {
  let restoreAuth: () => void;
  beforeEach(() => {
    restoreAuth = requireHttpAuth();
  });
  afterEach(() => restoreAuth());

  function upgrade(
    identity: Record<string, string>,
    guardianPrincipalId?: string,
  ) {
    const runtime = new RuntimeHttpServer();
    const server = {
      requestIP: () => ({ address: "127.0.0.1" }),
      upgrade: mock(() => true),
    };
    const query = new URLSearchParams();
    if (guardianPrincipalId !== undefined) {
      query.set("guardianPrincipalId", guardianPrincipalId);
    }
    const response = runtime["handleLiveVoiceUpgrade"](
      new Request(`http://127.0.0.1/v1/live-voice?${query}`, {
        headers: { ...upgradeHeaders, ...identity },
      }),
      server as unknown as ReturnType<typeof Bun.serve>,
    );
    return { response, server };
  }

  test("forwards the gateway-admitted guardian identity to the session", () => {
    const { response, server } = upgrade(gatewayIdentityHeaders, "user-123");
    expect(response).toBeUndefined();
    expect(server.upgrade).toHaveBeenCalledWith(expect.any(Request), {
      data: { wsType: "live-voice", guardianPrincipalId: "user-123" },
    });
  });

  test("accepts gateway clients without a guardian identity", () => {
    const { response, server } = upgrade(gatewayIdentityHeaders);
    expect(response).toBeUndefined();
    expect(server.upgrade).toHaveBeenCalledWith(expect.any(Request), {
      data: { wsType: "live-voice" },
    });
  });

  test("rejects a forwarded actor identity — the dial asserts the gateway service", () => {
    const { response, server } = upgrade(actorIdentityHeaders, "user-123");
    expect(response?.status).toBe(401);
    expect(server.upgrade).not.toHaveBeenCalled();
  });

  test("rejects an upgrade with no forwarded identity", () => {
    const { response, server } = upgrade({});
    expect(response?.status).toBe(401);
    expect(server.upgrade).not.toHaveBeenCalled();
  });
});
