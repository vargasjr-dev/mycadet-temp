import { describe, expect, test } from "bun:test";

import { deriveAssistantStatus } from "./assistant-status";
import type { AssistantRequestState } from "../assistant/use-assistant-request";
import type { AssistantResolution } from "../assistant/resolution-contract";

// A fully-loaded baseline (the shell resolved an assistant) that each test
// perturbs one arm at a time, so every assertion isolates the single input it
// cares about. Shape is exactly the shell's own resolution state — the web
// assistant iframe reports nothing.
const resolved: AssistantRequestState = {
  status: "ready",
  assistant: { id: "a1", version: "1", url: "https://assistant.example" },
} satisfies AssistantResolution;

describe("deriveAssistantStatus", () => {
  test("idle once the assistant is fully loaded", () => {
    expect(deriveAssistantStatus(resolved)).toBe("idle");
  });

  test("authFailed when the resolution was rejected by platform auth", () => {
    // The shell's own resolution coming back `unauthenticated` IS the auth
    // failure — there is no separate session question to ask.
    expect(deriveAssistantStatus({ status: "unauthenticated" })).toBe(
      "authFailed",
    );
  });

  test("error when the resolution request failed for a non-auth reason", () => {
    // Network failure, timeout, contract mismatch — the assistant failed to
    // come up. No HTTP status rides the request-level failure; the arms of
    // the resolution itself carry the auth distinction.
    expect(deriveAssistantStatus({ status: "error" })).toBe("error");
  });

  test("disconnected while the resolution is still in flight", () => {
    expect(deriveAssistantStatus({ status: "loading" })).toBe("disconnected");
  });

  test("disconnected when nothing is resolved to host", () => {
    // The chooser owns the window (nothing chosen, no assistants at all), or
    // the assistant exists but isn't usable — no live data plane either way.
    const nothing: AssistantResolution[] = [
      { status: "selection", assistants: [] },
      { status: "empty" },
      { status: "notReady" },
      { status: "unavailable" },
    ];
    for (const state of nothing) {
      expect(deriveAssistantStatus(state as AssistantRequestState)).toBe(
        "disconnected",
      );
    }
  });

  test("no thinking state exists — the dot rests at idle while the assistant works", () => {
    // Turn phase and SSE liveness were the web bundle's facts, and the web
    // bundle carries no status notion at all (it mounts only once the
    // assistant is fully loaded). Per-turn granularity returns with the
    // desktop layer's own vantage.
    expect(deriveAssistantStatus(resolved)).not.toBe("thinking");
  });
});
