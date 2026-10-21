import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseTunnelRecord,
  TUNNEL_PROVIDERS,
} from "@mycadet/service-contracts/ingress";

import type { AssistantEntry } from "../lib/assistant-config.js";

import {
  clearIngressUrl,
  readIngressPublicBaseUrl,
  parseGatewayPortFromEntryUrls,
  saveIngressUrl,
  savePairingTunnel,
} from "../lib/ingress-config.js";

const tempDirs: string[] = [];

function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "ingress-config-ws-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("readIngressPublicBaseUrl", () => {
  test("reads back what saveIngressUrl saved", () => {
    const ws = makeWorkspace();
    expect(readIngressPublicBaseUrl(ws)).toBeNull();

    saveIngressUrl(ws, "https://tunnel.example.ts.net");

    expect(readIngressPublicBaseUrl(ws)).toBe("https://tunnel.example.ts.net");
    clearIngressUrl(ws);
    expect(readIngressPublicBaseUrl(ws)).toBeNull();
  });
});

describe("last-tunnel record", () => {
  function readIngress(ws: string) {
    const config = JSON.parse(readFileSync(join(ws, "config.json"), "utf-8"));
    return config.ingress;
  }

  test("saveIngressUrl records the provider, URL, and assistant ID", () => {
    const ws = makeWorkspace();

    saveIngressUrl(
      ws,
      "https://a.trycloudflare.com",
      "ingress-test",
      "cloudflare",
    );

    const ingress = readIngress(ws);
    expect(ingress.publicBaseUrl).toBe("https://a.trycloudflare.com");
    expect(ingress.lastTunnel).toEqual({
      provider: "cloudflare",
      publicBaseUrl: "https://a.trycloudflare.com",
    });
    expect(ingress.assistantId).toBe("ingress-test");
  });

  test("clearIngressUrl drops the URL but keeps the tunnel and assistant records", () => {
    const ws = makeWorkspace();
    saveIngressUrl(
      ws,
      "https://tunnel.example.ts.net",
      "ingress-test",
      "tailscale",
    );

    clearIngressUrl(ws);

    const ingress = readIngress(ws);
    expect(ingress.publicBaseUrl).toBeUndefined();
    expect(ingress.lastTunnel).toEqual({
      provider: "tailscale",
      publicBaseUrl: "https://tunnel.example.ts.net",
    });
    expect(ingress.assistantId).toBe("ingress-test");
  });

  test("saving without a provider leaves an existing lastTunnel untouched", () => {
    const ws = makeWorkspace();
    saveIngressUrl(ws, "https://one.ngrok.app", undefined, "ngrok");

    saveIngressUrl(ws, "https://two.ngrok.app");

    const ingress = readIngress(ws);
    expect(ingress.publicBaseUrl).toBe("https://two.ngrok.app");
    expect(ingress.lastTunnel).toEqual({
      provider: "ngrok",
      publicBaseUrl: "https://one.ngrok.app",
    });
  });

  test("saving without a provider records no tunnel", () => {
    const ws = makeWorkspace();

    saveIngressUrl(ws, "https://one.ngrok.app");

    const ingress = readIngress(ws);
    expect(ingress.lastTunnel).toBeUndefined();
    expect(ingress.assistantId).toBeUndefined();
  });

  test("every provider the CLI writes is one the shared parser accepts", () => {
    // The daemon reads these records through parseTunnelRecord, so what
    // `cadet tunnel` writes has to survive that parse for every provider.
    for (const provider of TUNNEL_PROVIDERS) {
      const ws = makeWorkspace();
      saveIngressUrl(ws, `https://${provider}.test`, undefined, provider);
      expect(parseTunnelRecord(readIngress(ws).lastTunnel)).toEqual({
        provider,
        publicBaseUrl: `https://${provider}.test`,
      });
    }
  });
});

describe("pairing-tunnel record", () => {
  function readIngress(ws: string) {
    const config = JSON.parse(readFileSync(join(ws, "config.json"), "utf-8"));
    return config.ingress;
  }

  test("records the tunnel and the assistant it fronts", () => {
    const ws = makeWorkspace();
    saveIngressUrl(ws, "https://webhooks.ngrok.app", undefined, "ngrok");

    savePairingTunnel(
      ws,
      { provider: "tailscale", publicBaseUrl: "https://host.example.ts.net" },
      "ingress-test",
    );

    // The webhook callback base and the tunnel that owns it stay put; the
    // daemon reads the pairing record beside them.
    const ingress = readIngress(ws);
    expect(ingress.publicBaseUrl).toBe("https://webhooks.ngrok.app");
    expect(ingress.lastTunnel.provider).toBe("ngrok");
    expect(ingress.pairingTunnel).toEqual({
      provider: "tailscale",
      publicBaseUrl: "https://host.example.ts.net",
    });
    expect(ingress.assistantId).toBe("ingress-test");
  });

  test("a null record drops the key and leaves the rest alone", () => {
    const ws = makeWorkspace();
    saveIngressUrl(ws, "https://webhooks.ngrok.app", undefined, "ngrok");
    savePairingTunnel(ws, {
      provider: "tailscale",
      publicBaseUrl: "https://host.example.ts.net",
    });

    savePairingTunnel(ws, null);

    const ingress = readIngress(ws);
    expect(ingress.pairingTunnel).toBeUndefined();
    expect(ingress.publicBaseUrl).toBe("https://webhooks.ngrok.app");
    expect(ingress.lastTunnel.provider).toBe("ngrok");
  });

  test("saveIngressUrl takes the address back from a pairing record", () => {
    // A run that owns `publicBaseUrl` publishes the address to pair against,
    // so a record from an earlier tailnet-only run must not outrank it.
    const ws = makeWorkspace();
    savePairingTunnel(ws, {
      provider: "tailscale",
      publicBaseUrl: "https://host.example.ts.net",
    });

    saveIngressUrl(ws, "https://one.ngrok.app", undefined, "ngrok");

    expect(readIngress(ws).pairingTunnel).toBeUndefined();
  });

  test("what the CLI writes is what the shared parser accepts", () => {
    const ws = makeWorkspace();
    savePairingTunnel(ws, {
      provider: "tailscale",
      publicBaseUrl: "https://host.example.ts.net",
    });

    expect(parseTunnelRecord(readIngress(ws).pairingTunnel)).toEqual({
      provider: "tailscale",
      publicBaseUrl: "https://host.example.ts.net",
    });
  });
});

describe("parseGatewayPortFromEntryUrls", () => {
  test("prefers the loopback localUrl over runtimeUrl", () => {
    expect(
      parseGatewayPortFromEntryUrls({
        assistantId: "a",
        localUrl: "http://127.0.0.1:7830",
        runtimeUrl: "https://stale-tunnel.ngrok-free.dev",
      } as AssistantEntry),
    ).toBe(7830);
  });

  test("falls back to runtimeUrl when localUrl is absent", () => {
    expect(
      parseGatewayPortFromEntryUrls({
        assistantId: "a",
        runtimeUrl: "http://localhost:9123",
      } as AssistantEntry),
    ).toBe(9123);
  });

  test("is undefined when neither URL carries an explicit port", () => {
    expect(
      parseGatewayPortFromEntryUrls({
        assistantId: "a",
        runtimeUrl: "https://runtime.example.com/a",
      } as AssistantEntry),
    ).toBeUndefined();
    expect(parseGatewayPortFromEntryUrls(undefined)).toBeUndefined();
  });
});
