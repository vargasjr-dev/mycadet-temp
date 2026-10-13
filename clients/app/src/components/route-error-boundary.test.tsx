import { afterEach, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";

import { RouteErrorBoundary } from "@app/components/route-error-boundary";
import { changeLocale, t } from "@app/i18n";

const routers: ReturnType<typeof createMemoryRouter>[] = [];

function renderFailure(error: Error | Response) {
  const router = createMemoryRouter([
    {
      path: "/",
      loader: () => {
        throw error;
      },
      Component: () => null,
      ErrorBoundary: RouteErrorBoundary,
    },
  ]);
  routers.push(router);
  render(<RouterProvider router={router} />);
}

afterEach(async () => {
  cleanup();
  for (const router of routers.splice(0)) router.dispose();
  await changeLocale("en");
  localStorage.removeItem("device:locale");
});

test("a failed route chunk uses app translations and the inline retry UI", async () => {
  await changeLocale("es");
  renderFailure(new TypeError("Failed to fetch dynamically imported module"));
  const alert = await screen.findByRole("alert");
  expect(alert.getAttribute("data-variant")).toBe("chunk-fail");
  expect(screen.getByText(t("routeErrorBoundary.chunkFailBody"))).toBeDefined();
  expect(
    screen.getByRole("button", { name: t("routeErrorBoundary.reload") }),
  ).toBeDefined();
});

test("a missing route response uses the full page error UI", async () => {
  renderFailure(new Response(null, { status: 404 }));
  expect(
    await screen.findByRole("heading", { name: "Page not found" }),
  ).toBeDefined();
  expect(document.querySelector('[data-variant="full-page"]')).not.toBeNull();
});
