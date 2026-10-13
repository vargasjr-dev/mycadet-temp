import { afterEach, expect, mock, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";

const startAuthFlow = mock(() => new Promise<void>(() => {}));
mock.module("@web/runtime/native-auth", () => ({ startAuthFlow }));
const { AuthWelcomeScreen } = await import("./auth-welcome-screen");
const initialBridge = window.cadet;
afterEach(() => {
  cleanup();
  window.cadet = initialBridge;
  startAuthFlow.mockClear();
});
function show() {
  render(
    <MemoryRouter>
      <AuthWelcomeScreen
        returnTo="/assistant"
        secondary={{ label: "Sign up", href: "/account/signup" }}
      />
    </MemoryRouter>,
  );
}

test("browser disables login while the provider handoff is pending", () => {
  window.cadet = undefined;
  show();
  fireEvent.click(screen.getByRole("button", { name: "Log In" }));
  expect(
    (screen.getByRole("button", { name: "Log In" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(startAuthFlow).toHaveBeenCalledWith(
    "workos",
    "/account/provider/callback?returnTo=%2Fassistant",
    { returnTo: "/assistant" },
  );
});

test("desktop cancellation ignores a late failure from the cancelled flow", async () => {
  let rejectFlow!: (error: Error) => void;
  startAuthFlow.mockImplementationOnce(
    () =>
      new Promise<void>((_, reject) => {
        rejectFlow = reject;
      }),
  );
  const cancelOAuth = mock(async () => {});
  Reflect.set(window, "cadet", {
    platform: "electron",
    auth: { cancelOAuth },
  });
  show();
  fireEvent.click(screen.getByRole("button", { name: "Log In" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(cancelOAuth).toHaveBeenCalledTimes(1);
  await act(async () => {
    rejectFlow(new Error("late failure"));
  });
  expect(screen.getByRole("button", { name: "Log In" })).toBeTruthy();
  expect(
    screen.queryByText("Something went wrong. Please try again."),
  ).toBeNull();
});
