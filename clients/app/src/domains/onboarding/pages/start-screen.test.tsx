import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const navigateMock = mock((..._args: unknown[]) => {});
mock.module("react-router", () => ({
  useNavigate: () => navigateMock,
}));

// Light passthrough so the screen renders in happy-dom.
mock.module("@mycadet/design-library/components/button", () => ({
  Button: ({
    children,
    onClick,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
  }) => <button onClick={onClick}>{children}</button>,
}));

const { StartScreen } = await import(
  "@app/domains/onboarding/pages/start-screen"
);

describe("StartScreen", () => {
  beforeEach(() => navigateMock.mockClear());
  afterEach(cleanup);

  // It REPLACES: the funnel is one history entry, so Back can never re-enter
  // it once setup finishes (see `onboarding-navigation.ts`). This screen is
  // reached only via Back in the first place, so a push here would put it
  // straight back on the stack.
  // The CTA creates an assistant, so it carries the new-assistant marker: this
  // screen is the Back target in platform mode, and without the marker a user
  // whose selected assistant is already onboarded is bounced to /assistant on
  // the way back in. Non-production builds rewrite research to the hatch
  // screen with the skip marker.
  test("the single CTA re-enters the funnel as a new-assistant walk", () => {
    render(<StartScreen />);

    fireEvent.click(screen.getByText("Create your assistant"));

    expect(navigateMock).toHaveBeenCalledWith(
      "/assistant/onboarding/hatching?new_assistant=1&skip_research=1",
      { replace: true },
    );
  });
});
