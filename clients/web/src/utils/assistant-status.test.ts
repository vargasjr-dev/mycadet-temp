import { describe, expect, test } from "bun:test";

import {
  type AssistantStatusInputs,
  deriveAssistantStatus,
} from "@/utils/assistant-status";

// A fully-working baseline (active, connected, idle turn) that each test
// perturbs one signal at a time, so every assertion isolates the single
// input it cares about.
const working: AssistantStatusInputs = {
  lifecycleKind: "active",
  isSSEConnected: true,
  turnPhase: "idle",
};

describe("deriveAssistantStatus", () => {
  test("idle when active, authenticated, connected, and no turn in flight", () => {
    expect(deriveAssistantStatus(working)).toBe("idle");
  });

  test("authFailed when the resolution was rejected by platform auth", () => {
    // The assistant's own resolution failing with 401/403 IS the auth
    // failure — there is no separate session question. It outranks every
    // other signal: even mid-turn, disconnected.
    expect(
      deriveAssistantStatus({
        lifecycleKind: "error",
        lifecycleErrorStatus: 401,
        isSSEConnected: false,
        turnPhase: "thinking",
      }),
    ).toBe("authFailed");
    expect(
      deriveAssistantStatus({
        ...working,
        lifecycleKind: "error",
        lifecycleErrorStatus: 403,
      }),
    ).toBe("authFailed");
  });

  test("error when the lifecycle terminally failed on a non-auth status", () => {
    expect(
      deriveAssistantStatus({
        ...working,
        lifecycleKind: "error",
        lifecycleErrorStatus: 500,
      }),
    ).toBe("error");
    expect(deriveAssistantStatus({ ...working, lifecycleKind: "error" })).toBe(
      "error",
    );
  });

  test("disconnected for every non-active lifecycle phase", () => {
    const nonActive: AssistantStatusInputs["lifecycleKind"][] = [
      "loading",
      "initializing",
      "cleaning_up",
      "self_hosted",
    ];
    for (const lifecycleKind of nonActive) {
      expect(deriveAssistantStatus({ ...working, lifecycleKind })).toBe(
        "disconnected",
      );
    }
  });

  test("disconnected when active but the SSE stream is down", () => {
    expect(deriveAssistantStatus({ ...working, isSSEConnected: false })).toBe(
      "disconnected",
    );
  });

  test("thinking while a turn is queued, thinking, or streaming", () => {
    for (const turnPhase of ["queued", "thinking", "streaming"] as const) {
      expect(deriveAssistantStatus({ ...working, turnPhase })).toBe("thinking");
    }
  });

  test("awaiting_user_input rests at idle, not thinking", () => {
    // The agent is waiting on the user, so the pulse should rest rather than
    // imply active work.
    expect(
      deriveAssistantStatus({ ...working, turnPhase: "awaiting_user_input" }),
    ).toBe("idle");
  });

  test("an errored turn on an otherwise-healthy assistant stays idle", () => {
    // Turn-level errors surface in the chat UI; the menu-bar dot reflects the
    // assistant's connection health, which is still fine here.
    expect(deriveAssistantStatus({ ...working, turnPhase: "errored" })).toBe(
      "idle",
    );
  });
});
