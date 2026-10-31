import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { LockfileAssistant } from "@mycadet/local-mode/contract";

// The wrapper under test orchestrates the real connect primitive, so we drive
// its external seams rather than the primitive itself: the host-routed readyz
// probe the prime dials, and the wake repair call. The renderer holds no
// gateway credential — the prime seeds a tokenless slot — so there is no
// token machinery to stub.
const host = await import("@/runtime/local-mode-host");

let wakeLocalAssistantHost = mock(async (_id: string) => ({ ok: true }));

mock.module("@/runtime/local-mode-host", () => ({
  ...host,
  wakeLocalAssistantHost: (id: string) => wakeLocalAssistantHost(id),
}));

// The prime's only dial is the host-routed readyz probe; each test installs
// its own response impl and reads the attempt count off the stub.
let probeImpl: () => Promise<Response> = async () =>
  Response.json({ status: "ok", ready: true });
let probeCalls = 0;
globalThis.fetch = (async () => {
  probeCalls += 1;
  return probeImpl();
}) as unknown as typeof fetch;

const realConnection = await import("@/lib/self-hosted/connection");
mock.module("@/lib/self-hosted/connection", () => ({
  ...realConnection,
  setSelfHostedConnection: () => {},
}));

const { primeLocalGatewayConnectionWithRepair, LOCAL_GATEWAY_RESTART_RETRY } =
  await import("@/lib/local-mode");

// Keep the ride-out loop fast: many attempts, no real wait between them.
LOCAL_GATEWAY_RESTART_RETRY.intervalMs = 0;

function selectLocalAssistant(): void {
  // The host stamps the served assistant; the renderer synthesizes it.
  window.__CADET_CONFIG__ = { remote: "local", assistantId: "local-a" };
}

const probeOk = async () => Response.json({ status: "ok", ready: true });
const probeStatus =
  (status: number, message = "probe failed") =>
  async () =>
    new Response(message, { status });

beforeEach(() => {
  // The prime only dials in local mode; the previous test's afterEach leaves
  // the cloud stamp behind, so restore the local world every test.
  probeCalls = 0;
  probeImpl = probeOk;
  wakeLocalAssistantHost = mock(async (_id: string) => ({ ok: true }));
  selectLocalAssistant();
});

afterEach(() => {
  localStorage.clear();
  window.__CADET_CONFIG__ = { remote: "cloud" };
});

describe("primeLocalGatewayConnectionWithRepair", () => {
  test("a clean first attempt never wakes the assistant", async () => {
    await primeLocalGatewayConnectionWithRepair();
    expect(wakeLocalAssistantHost).not.toHaveBeenCalled();
  });

  test("a repairable failure wakes once, then retries and succeeds", async () => {
    // Fail the first probe (a route the gateway does not answer), succeed
    // once wake has run.
    probeImpl = async () => (probeCalls === 1 ? probeStatus(404)() : probeOk());

    await primeLocalGatewayConnectionWithRepair();

    expect(wakeLocalAssistantHost).toHaveBeenCalledTimes(1);
    expect(wakeLocalAssistantHost).toHaveBeenCalledWith("local-a");
    // One failing probe + one succeeding retry.
    expect(probeCalls).toBe(2);
  });

  test("a starting gateway wakes once, then rides out the restart and reconnects", async () => {
    // A loaded web bundle guarantees a cadet gateway that started, so there
    // is no boot startup window to wait out: the first prime's 503
    // "starting" is a repairable failure, the wake restarts the gateway, and
    // the post-wake ride-out lands once it is back.
    probeImpl = async () =>
      probeCalls < 3 ? probeStatus(503, "starting")() : probeOk();

    await primeLocalGatewayConnectionWithRepair();

    expect(wakeLocalAssistantHost).toHaveBeenCalledTimes(1);
    expect(probeCalls).toBe(3);
  });

  test("a transport error wakes once, then reconnects on the post-wake probe", async () => {
    // A loaded web bundle guarantees a cadet gateway that started, so the
    // first prime is a single attempt: a transport failure is a stopped
    // gateway, the repair wakes it, and the post-wake ride-out lands once
    // the restarted gateway is back.
    probeImpl = async () => {
      if (probeCalls <= LOCAL_GATEWAY_RESTART_RETRY.attempts) {
        throw new TypeError("Failed to fetch");
      }
      return probeOk();
    };

    await primeLocalGatewayConnectionWithRepair();

    expect(wakeLocalAssistantHost).toHaveBeenCalledTimes(1);
    expect(probeCalls).toBe(LOCAL_GATEWAY_RESTART_RETRY.attempts + 1);
  });

  test("a still-failing retry surfaces the original error and wakes only once", async () => {
    probeImpl = probeStatus(404, "no such route");

    const err = await primeLocalGatewayConnectionWithRepair().catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(host.GuardianTokenError);
    expect(wakeLocalAssistantHost).toHaveBeenCalledTimes(1);
  });

  test("a failed wake surfaces the original error without retrying", async () => {
    probeImpl = probeStatus(404, "no such route");
    wakeLocalAssistantHost = mock(async () => ({
      ok: false,
      error: "no sibling env",
    }));

    const err = await primeLocalGatewayConnectionWithRepair().catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(host.GuardianTokenError);
    // The first probe failed and wake failed — the connection is never retried.
    expect(probeCalls).toBe(1);
  });

  test("a repairable failure for a paired target never wakes and rethrows", async () => {
    // Wake is cloud:"local"-only (it refuses paired entries), so a paired
    // connect failure must propagate immediately instead of spawning a wake
    // that is guaranteed to refuse. The paired target arrives explicitly —
    // the served entry can never classify as paired.
    const pairedTarget = {
      assistantId: "paired-a",
      cloud: "custom",
      ipAddress: "gw.example.com",
      port: 443,
    } as LockfileAssistant;
    probeImpl = probeStatus(404, "token gone");

    const err = await primeLocalGatewayConnectionWithRepair(pairedTarget).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(host.GuardianTokenError);
    expect(wakeLocalAssistantHost).not.toHaveBeenCalled();
  });

  test("a non-repairable 403 surfaces immediately and never wakes", async () => {
    probeImpl = probeStatus(403, "forbidden");

    const err = await primeLocalGatewayConnectionWithRepair().catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(host.GuardianTokenError);
    expect((err as InstanceType<typeof host.GuardianTokenError>).status).toBe(
      403,
    );
    expect(wakeLocalAssistantHost).not.toHaveBeenCalled();
  });

  test("rides out a wake-restarted gateway that is still starting, then reconnects", async () => {
    // First probe fails (repairable) → wake restarts the gateway → the post-wake
    // probe races the gateway coming back up: it answers 503 "starting" once
    // before it succeeds. The ride-out retries instead of dead-ending.
    probeImpl = async () => {
      if (probeCalls === 1) {
        return probeStatus(404, "no such route")();
      }
      if (probeCalls === 2) {
        return probeStatus(503, "starting")();
      }
      return probeOk();
    };

    await primeLocalGatewayConnectionWithRepair();

    expect(wakeLocalAssistantHost).toHaveBeenCalledTimes(1);
    // One pre-wake probe that fails, then two post-wake probes: the first
    // answers 503 and is ridden out, the second succeeds.
    expect(probeCalls).toBe(3);
  });

  test("a wake-restarted gateway stuck starting surfaces the last error after the budget", async () => {
    // Wake succeeds but the gateway never finishes starting — the ride-out
    // exhausts its budget and the last transient error propagates so the recovery
    // controls still surface.
    probeImpl = async () =>
      probeCalls === 1
        ? probeStatus(404, "no such route")()
        : probeStatus(503, "starting")();

    const err = await primeLocalGatewayConnectionWithRepair().catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(host.GuardianTokenError);
    expect((err as InstanceType<typeof host.GuardianTokenError>).status).toBe(
      503,
    );
    expect(wakeLocalAssistantHost).toHaveBeenCalledTimes(1);
  });

  test("a post-wake probe 401 surfaces immediately as a spent credential", async () => {
    probeImpl = probeStatus(401, "Failed to refresh guardian token");

    const err = await primeLocalGatewayConnectionWithRepair().catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(host.GuardianTokenError);
    expect((err as InstanceType<typeof host.GuardianTokenError>).status).toBe(
      401,
    );
    expect(wakeLocalAssistantHost).toHaveBeenCalledTimes(1);
    // One pre-wake probe plus one terminal post-wake probe.
    expect(probeCalls).toBe(2);
  });
});
