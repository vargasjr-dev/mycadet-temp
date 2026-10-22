import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  clearGatewayToken,
  isGatewayAuthEnabled,
  isGatewayAuthMode,
  setRemoteGatewayToken,
} from "@/lib/auth/gateway-session";
import { setSelfHostedConnection } from "@/lib/self-hosted/connection";
import type { LockfileAssistant } from "@/runtime/local-mode-host";
import { useLockfileStore } from "@/stores/lockfile-store";

beforeEach(() => {
  clearGatewayToken();
});

afterEach(() => {
  window.__CADET_CONFIG__ = { remote: "cloud" };
  clearGatewayToken();
  setSelfHostedConnection(null);
  useLockfileStore.setState({ lockfile: null, committed: false });
});

describe("remote gateway mode", () => {
  test("is enabled but not active until an in-memory token exists", () => {
    window.__CADET_CONFIG__ = { remote: "docker" };

    expect(isGatewayAuthEnabled()).toBe(true);
    expect(isGatewayAuthMode()).toBe(false);

    setRemoteGatewayToken({
      accessToken: "remote-token",
      accessTokenExpiresAt: "2999-01-01T00:00:00.000Z",
    });

    expect(isGatewayAuthMode()).toBe(true);
  });
});

describe("paired selection", () => {
  function selectPaired(runtimeUrl?: string): void {
    const paired = {
      assistantId: "paired-a",
      cloud: "local",
      ...(runtimeUrl != null && { runtimeUrl }),
    } as LockfileAssistant;
    useLockfileStore.setState({
      lockfile: { assistants: [paired], activeAssistant: "paired-a" },
    });
  }

  test("gateway auth is enabled for a paired selection with a usable runtimeUrl", () => {
    window.__CADET_CONFIG__ = undefined;
    selectPaired("https://gw.example.com");

    expect(isGatewayAuthEnabled()).toBe(true);
  });

  test("gateway auth stays disabled when the paired runtimeUrl is unusable", () => {
    window.__CADET_CONFIG__ = undefined;
    selectPaired();

    expect(isGatewayAuthEnabled()).toBe(false);
  });

  test("gateway auth stays disabled for a paired selection outside local mode", () => {
    selectPaired("https://gw.example.com");

    expect(isGatewayAuthEnabled()).toBe(false);
  });

  test("paired auth mode requires a host-primed proxy connection", () => {
    window.__CADET_CONFIG__ = undefined;
    selectPaired("https://gw.example.com");
    const fetchSpy = mock(async () => {
      throw new Error("unexpected fetch");
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    expect(isGatewayAuthMode()).toBe(false);

    setSelfHostedConnection({
      url: window.location.origin,
      token: null,
    });

    expect(isGatewayAuthMode()).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("local selection", () => {
  function selectLocal(gatewayPort?: number): void {
    const local = {
      assistantId: "local-a",
      cloud: "local",
      ...(gatewayPort != null && {
        resources: { gatewayPort, daemonPort: 8501 },
      }),
    } as unknown as LockfileAssistant;
    useLockfileStore.setState({
      lockfile: { assistants: [local], activeAssistant: "local-a" },
    });
  }

  test("gateway-auth mode is topology-based — no renderer token exists", () => {
    window.__CADET_CONFIG__ = undefined;
    selectLocal(20100);

    // The trusted host owns bearer custody; the renderer holds no token, so
    // the local signal is the resolvable gateway, not a cached credential.
    expect(isGatewayAuthMode()).toBe(true);
  });

  test("gateway-auth mode stays off while the gateway is unresolvable", () => {
    window.__CADET_CONFIG__ = undefined;
    selectLocal();

    expect(isGatewayAuthMode()).toBe(false);
  });
});
