import { afterEach, expect, spyOn, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { toast } from "@mycadet/design-library/components/toast";
import { DesktopChrome } from "./standalone";

const request = spyOn(globalThis, "fetch");

afterEach(() => {
  cleanup();
  request.mockReset();
});

// sonner's render loop runs on a frame; a DOM-less environment has none.
let frameHandle = 0;
globalThis.requestAnimationFrame ??= (cb: FrameRequestCallback) => {
  setTimeout(() => cb(performance.now()), 0);
  frameHandle += 1;
  return frameHandle;
};

test("the app's root mounts the toast outlet so every toast.* call renders", async () => {
  // DesktopChrome is the layout every route renders through and both
  // entries boot via; a stub child keeps the test off the network.
  const router = createMemoryRouter(
    [
      {
        path: "/",
        Component: DesktopChrome,
        children: [{ path: "/", Component: () => null }],
      },
    ],
    { initialEntries: ["/"] },
  );
  render(<RouterProvider router={router} />);
  // Error toasts render with role=alert; the message must be readable.
  toast.error("The retire failed.");
  expect(await screen.findByRole("alert")).toBeDefined();
  expect(await screen.findByText("The retire failed.")).toBeDefined();
});
