/**
 * Unit tests for `useAssistantQuery`'s polling-cadence policy.
 *
 * We test the exported `pollIntervalFor` decision function the
 * production `refetchInterval` callback uses, so a future change to
 * the transient-phase set is exercised here automatically instead of
 * being silently duplicated.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// The real chain (probe → mirror → fact) is exercised below, so only the
// network call and the gateway-mode flag are mocked — registered before the
// first queries import so the module binds to them.
const apiActual = await import("@/assistant/api");
type AssistantResult = Awaited<ReturnType<typeof apiActual.getAssistant>>;
const getAssistantMock = mock<(id?: string) => Promise<AssistantResult>>(() =>
  Promise.reject(new Error("unmocked")),
);
mock.module("@/assistant/api", () => ({
  ...apiActual,
  getAssistant: (id?: string) => getAssistantMock(id),
}));

const localModeActual = await import("@/lib/local-mode");
let mockGatewaySessionLive = false;
mock.module("@/lib/local-mode", () => ({
  ...localModeActual,
  isGatewaySessionLive: () => mockGatewaySessionLive,
}));

import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

const {
  ASSISTANT_QUERY_KEY,
  assistantQueryKey,
  pollIntervalFor,
  POLL_INTERVAL_MS,
  probeBootResolution,
} = await import("@/assistant/queries");
import type { Assistant, GetAssistantResult } from "@/assistant/api";

beforeEach(() => {
  mockGatewaySessionLive = false;
  getAssistantMock.mockClear();
  useResolvedAssistantsStore.setState({
    assistants: [],
    activeAssistantId: null,
  });
});

describe("assistantQueryKey", () => {
  test("returns the base key by reference when nothing is selected (off-path is byte-identical)", () => {
    // Same reference, not just a deep-equal copy — so every existing
    // setQueryData / invalidate site that uses ASSISTANT_QUERY_KEY keeps
    // matching when multi-assistant is off.
    expect(assistantQueryKey()).toBe(ASSISTANT_QUERY_KEY);
    expect(assistantQueryKey(null)).toBe(ASSISTANT_QUERY_KEY);
  });

  test("suffixes the selected id so a switch is a distinct cache key", () => {
    expect(assistantQueryKey("ast-2")).toEqual([
      ...ASSISTANT_QUERY_KEY,
      "ast-2",
    ]);
    expect(assistantQueryKey("ast-2")).not.toBe(ASSISTANT_QUERY_KEY);
    expect(assistantQueryKey("ast-2")).not.toEqual(assistantQueryKey("ast-3"));
  });
});

function okResult(
  status: "active" | "initializing" | "to_be_deleted",
  isLocal = false,
): GetAssistantResult {
  return {
    ok: true,
    status: 200,
    data: {
      id: "asst-1",
      status,
      is_local: isLocal,
    } as Partial<Assistant> as Assistant,
  };
}

describe("useAssistantQuery polling cadence", () => {
  test("does not poll while the result is undefined (query hasn't resolved)", () => {
    expect(pollIntervalFor(undefined)).toBe(false);
  });

  test("polls every 3s while the assistant is initializing", () => {
    expect(pollIntervalFor(okResult("initializing"))).toBe(POLL_INTERVAL_MS);
  });

  test("polls every 3s while the assistant is cleaning up", () => {
    // Raw server status `to_be_deleted` maps to lifecycle `kind:
    // "cleaning_up"` via `resolveAssistantLifecycleState`. Calling
    // out the raw → kind mapping here saves a future reader from
    // grepping for the `to_be_deleted` literal and wondering why a
    // "cleaning up" test fixture uses the wrong word.
    expect(pollIntervalFor(okResult("to_be_deleted"))).toBe(POLL_INTERVAL_MS);
  });

  test("stops polling once the assistant is active", () => {
    expect(pollIntervalFor(okResult("active"))).toBe(false);
  });

  test("stops polling for self-hosted active (is_local=true)", () => {
    // Self-hosted assistants resolve to `kind: "self_hosted"`, which
    // is a stable phase — no need to keep polling.
    expect(pollIntervalFor(okResult("active", true))).toBe(false);
  });

  test("stops polling on 404 (auto_hatch phase — recovery is mutation-driven)", () => {
    // 404 routes to `auto_hatch`, which the lifecycle hook resolves by
    // firing a hatch mutation. The poll has nothing useful to add
    // while we're waiting for the mutation to land.
    const notFound: GetAssistantResult = {
      ok: false,
      status: 404,
      error: {},
    };
    expect(pollIntervalFor(notFound)).toBe(false);
  });

  test("stops polling on terminal error", () => {
    const errored: GetAssistantResult = {
      ok: false,
      status: 500,
      error: { message: "Server error" },
    };
    expect(pollIntervalFor(errored)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The boot resolution's imperative face — the route guard's session facts
// ---------------------------------------------------------------------------
//
// The route guard awaits the boot resolution's probe so the guard's next
// read (`hasAssistants`) decides on the projected roster rather than a
// clock. These pins drive the real chain — `probeBootResolution` (the
// middleware's await) projects ok results into the roster.
describe("probeBootResolution", () => {
  test("a live session projects into the roster", async () => {
    getAssistantMock.mockImplementation(() =>
      Promise.resolve(okResult("active")),
    );
    await probeBootResolution();

    // The projection is the load-bearing half: the guard's next read
    // (`hasAssistants`) sees the roster the boot effect would have built.
    expect(useResolvedAssistantsStore.getState().assistants).toHaveLength(1);
    expect(useResolvedAssistantsStore.getState().activeAssistantId).toBe(
      "asst-1",
    );
  });

  test("a 401 projects nothing", async () => {
    // A rejection answers no roster rows — the guard decides on the empty
    // roster, and session death belongs to the resolution's reconnecting UI.
    getAssistantMock.mockImplementation(() =>
      Promise.resolve({
        ok: false,
        status: 401,
        error: {},
      } as GetAssistantResult),
    );
    await probeBootResolution();

    expect(useResolvedAssistantsStore.getState().assistants).toHaveLength(0);
  });

  test("a 404 (signed in, nothing to resolve) projects nothing — the guard funnels to onboarding", async () => {
    getAssistantMock.mockImplementation(() =>
      Promise.resolve({
        ok: false,
        status: 404,
        error: {},
      } as GetAssistantResult),
    );
    await probeBootResolution();

    expect(useResolvedAssistantsStore.getState().assistants).toHaveLength(0);
  });

  test("a transport failure projects nothing", async () => {
    // A fetch that never got an HTTP answer says nothing about the roster;
    // the guard decides on the empty roster.
    getAssistantMock.mockImplementation(() =>
      Promise.reject(new TypeError("fetch failed")),
    );
    await probeBootResolution();

    expect(useResolvedAssistantsStore.getState().assistants).toHaveLength(0);
  });

  test("gateway-auth mode probes nothing", () => {
    // The gateway issued the session itself — nothing to probe.
    mockGatewaySessionLive = true;

    return probeBootResolution().then(() => {
      expect(getAssistantMock).not.toHaveBeenCalled();
    });
  });
});
