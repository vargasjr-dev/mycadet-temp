/**
 * The entrance failsafe: false until the deadline passes, true after, and it
 * cleans its timer up on unmount.
 */

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";
import { useEntranceFailsafe } from "./use-entrance-failsafe";

function Probe({ deadlineMs }: { deadlineMs?: number }) {
  const expired = useEntranceFailsafe(deadlineMs);
  return <div data-expired={expired ? "yes" : "no"} />;
}

afterEach(() => {
  cleanup();
});

describe("useEntranceFailsafe", () => {
  test("has not fired immediately", () => {
    const { container } = render(<Probe deadlineMs={60_000} />);
    expect(container.querySelector('[data-expired="no"]')).toBeTruthy();
  });

  test("fires after the deadline and stays fired", async () => {
    const { container } = render(<Probe deadlineMs={20} />);
    expect(container.querySelector('[data-expired="no"]')).toBeTruthy();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    expect(container.querySelector('[data-expired="yes"]')).toBeTruthy();
  });
});
