import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import type { ReactNode } from "react";
import { beginOAuthFlow } from "@app/runtime/oauth-flow-state";
let authenticated = false;
mock.module("@app/stores/auth-store", () => ({
  useIsAuthenticated: () => authenticated,
  useIsSessionInitializing: () => false,
}));
mock.module("@app/hooks/use-account-cloud-gate", () => ({
  useAccountCloudGate: () => "enabled",
}));
const { useReturnToShortCircuit } =
  await import("./use-return-to-short-circuit");
const checkout = "/assistant/checkout?package=super";
const Wrapper = ({ children }: { children: ReactNode }) => (
  <MemoryRouter
    initialEntries={[
      `/account/signup?returnTo=${encodeURIComponent(checkout)}`,
    ]}
  >
    {children}
  </MemoryRouter>
);
afterEach(() => {
  authenticated = false;
  cleanup();
});
test("native account refresh cannot shortcut signup before its OAuth destination is resolved", () => {
  const { result, rerender } = renderHook(useReturnToShortCircuit, {
    wrapper: Wrapper,
  });
  expect(result.current).toEqual({ kind: "proceed", returnTo: checkout });
  const finish = beginOAuthFlow();
  try {
    authenticated = true;
    rerender();
    expect(result.current).toEqual({ kind: "proceed", returnTo: checkout });
  } finally {
    finish();
  }
  rerender();
  expect(result.current.kind).toBe("redirect");
});
