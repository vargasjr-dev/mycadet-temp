import { afterEach, describe, expect, mock, test } from "bun:test";

/**
 * The controller's session slot, stood in for.
 *
 * Toggled by the stub the way the real `toggleWatch` toggles it, so a press
 * that starts a session leaves the next press on the stop edge.
 */
let sessionActive = false;

const toggleWatchMock = mock(() => {
  sessionActive = !sessionActive;
  return Promise.resolve();
});

mock.module("@/domains/chat/watch/watch-controller", () => ({
  toggleWatch: toggleWatchMock,
  isWatchSessionActive: () => sessionActive,
}));

const { handleToggleWatchCommand } = await import("./watch-command");

afterEach(() => {
  toggleWatchMock.mockClear();
  sessionActive = false;
});

/**
 * The command is the door into a session that reads the user's screen, and the
 * companion surface's control is only the affordance in front of it.
 */
describe("the toggleWatch command", () => {
  test("starts a session", () => {
    handleToggleWatchCommand();

    expect(toggleWatchMock).toHaveBeenCalledTimes(1);
  });

  /**
   * Both edges through the one call, because the surface draws one control and
   * this side is the only one that knows which edge a press is.
   */
  test("stays one call for both edges", () => {
    handleToggleWatchCommand();
    handleToggleWatchCommand();

    expect(toggleWatchMock).toHaveBeenCalledTimes(2);
    expect(sessionActive).toBe(false);
  });

  /** `target` rides the command and is only ever read on the start edge. */
  test("hands the chosen target to the session", () => {
    handleToggleWatchCommand({ kind: "window", windowId: 1 });

    expect(toggleWatchMock).toHaveBeenCalledWith({
      target: { kind: "window", windowId: 1 },
    });
  });
});
