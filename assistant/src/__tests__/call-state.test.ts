import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { CallController } from "../calls/call-controller.js";
import {
  fireCallCompletionNotifier,
  fireCallQuestionNotifier,
  fireCallTranscriptNotifier,
  getCallController,
  registerCallCompletionNotifier,
  registerCallController,
  registerCallQuestionNotifier,
  registerCallTranscriptNotifier,
  unregisterCallCompletionNotifier,
  unregisterCallController,
  unregisterCallQuestionNotifier,
  unregisterCallTranscriptNotifier,
} from "../calls/call-state.js";
import { initializeDb } from "../persistence/db-init.js";

await initializeDb();

const controllers: CallController[] = [];

function makeController(sessionId: string): CallController {
  const controller = new CallController(
    sessionId,
    {
      sendTextToken: () => {},
      sendPlayUrl: () => {},
      endSession: () => {},
    },
    null,
    { progressNarrator: null },
  );
  controllers.push(controller);
  return controller;
}

afterEach(() => {
  for (const controller of controllers.splice(0)) {
    controller.destroy();
  }
});

describe("call-state", () => {
  // Clean up notifiers between tests
  beforeEach(() => {
    unregisterCallQuestionNotifier("test-conv");
    unregisterCallTranscriptNotifier("test-conv");
    unregisterCallCompletionNotifier("test-conv");
    unregisterCallController("test-session");
  });

  // ── Question notifiers ────────────────────────────────────────────

  test("registerCallQuestionNotifier + fireCallQuestionNotifier: callback receives args", () => {
    let receivedSessionId = "";
    let receivedQuestion = "";

    registerCallQuestionNotifier("test-conv", (callSessionId, question) => {
      receivedSessionId = callSessionId;
      receivedQuestion = question;
    });

    fireCallQuestionNotifier("test-conv", "session-123", "What is the date?");

    expect(receivedSessionId).toBe("session-123");
    expect(receivedQuestion).toBe("What is the date?");
  });

  test("unregisterCallQuestionNotifier: fire after unregister does nothing", () => {
    let called = false;

    registerCallQuestionNotifier("test-conv", () => {
      called = true;
    });

    unregisterCallQuestionNotifier("test-conv");
    fireCallQuestionNotifier("test-conv", "session-123", "Some question");

    expect(called).toBe(false);
  });

  test("fireCallQuestionNotifier does nothing when no notifier is registered", () => {
    // Should not throw
    fireCallQuestionNotifier("unregistered-conv", "session-1", "question");
  });

  // ── Transcript notifiers ──────────────────────────────────────────

  test("registerCallTranscriptNotifier + fireCallTranscriptNotifier: callback receives args", () => {
    let receivedSessionId = "";
    let receivedSpeaker = "";
    let receivedText = "";

    registerCallTranscriptNotifier(
      "test-conv",
      (callSessionId, speaker, text) => {
        receivedSessionId = callSessionId;
        receivedSpeaker = speaker;
        receivedText = text;
      },
    );

    fireCallTranscriptNotifier(
      "test-conv",
      "session-321",
      "caller",
      "Hello from caller",
    );

    expect(receivedSessionId).toBe("session-321");
    expect(receivedSpeaker).toBe("caller");
    expect(receivedText).toBe("Hello from caller");
  });

  test("unregisterCallTranscriptNotifier: fire after unregister does nothing", () => {
    let called = false;

    registerCallTranscriptNotifier("test-conv", () => {
      called = true;
    });

    unregisterCallTranscriptNotifier("test-conv");
    fireCallTranscriptNotifier("test-conv", "session-321", "assistant", "Test");

    expect(called).toBe(false);
  });

  test("fireCallTranscriptNotifier does nothing when no notifier is registered", () => {
    fireCallTranscriptNotifier(
      "unregistered-conv",
      "session-1",
      "caller",
      "text",
    );
  });

  // ── Completion notifiers ──────────────────────────────────────────

  test("registerCallCompletionNotifier + fireCallCompletionNotifier: callback receives callSessionId", () => {
    let receivedSessionId = "";

    registerCallCompletionNotifier("test-conv", (callSessionId) => {
      receivedSessionId = callSessionId;
    });

    fireCallCompletionNotifier("test-conv", "session-456");

    expect(receivedSessionId).toBe("session-456");
  });

  test("unregisterCallCompletionNotifier: fire after unregister does nothing", () => {
    let called = false;

    registerCallCompletionNotifier("test-conv", () => {
      called = true;
    });

    unregisterCallCompletionNotifier("test-conv");
    fireCallCompletionNotifier("test-conv", "session-456");

    expect(called).toBe(false);
  });

  test("fireCallCompletionNotifier does nothing when no notifier is registered", () => {
    // Should not throw
    fireCallCompletionNotifier("unregistered-conv", "session-1");
  });

  // ── Controller registry ─────────────────────────────────────────

  test("registerCallController + getCallController: retrieves controller", () => {
    const fakeController = makeController("fake-ctrl");

    registerCallController("test-session", fakeController);

    const retrieved = getCallController("test-session");
    expect(retrieved).toBe(fakeController);
  });

  test("unregisterCallController: getCallController returns undefined after unregister", () => {
    const fakeController = makeController("fake-ctrl-2");

    registerCallController("test-session", fakeController);
    unregisterCallController("test-session");

    const retrieved = getCallController("test-session");
    expect(retrieved).toBeUndefined();
  });

  test("getCallController returns undefined for unregistered session", () => {
    const retrieved = getCallController("nonexistent-session");
    expect(retrieved).toBeUndefined();
  });

  test("registering a new controller for same session overwrites the previous one", () => {
    const first = makeController("first");
    const second = makeController("second");

    registerCallController("test-session", first);
    registerCallController("test-session", second);

    const retrieved = getCallController("test-session");
    expect(retrieved).toBe(second);
  });
});
