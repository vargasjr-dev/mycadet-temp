import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import { AuthWelcomeScreen } from "./auth-welcome-screen";

afterEach(() => cleanup());

function show() {
  render(
    <MemoryRouter>
      <AuthWelcomeScreen
        secondary={{ label: "Sign up", href: "/account/signup" }}
      />
    </MemoryRouter>,
  );
}

test("the login button is inert with the Coming Soon! label", () => {
  show();
  const button = screen.getByRole("button", {
    name: "Coming Soon!",
  }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  fireEvent.click(button);
  expect(screen.queryByRole("button", { name: "Log In" })).toBeNull();
});
