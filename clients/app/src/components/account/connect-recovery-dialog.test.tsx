import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ConnectRecoveryDialog } from "./connect-recovery-dialog";

afterEach(() => cleanup());

function renderDialog(
  props: {
    onRepair?: () => void;
    onRetire?: () => void;
    errorMessage?: string;
  } = {},
) {
  return render(
    <ConnectRecoveryDialog
      open
      assistantName="Office Mac"
      isPending={false}
      errorMessage={props.errorMessage}
      onCancel={() => {}}
      onRepair={props.onRepair ?? (() => {})}
      onRetire={props.onRetire ?? (() => {})}
    />,
  );
}

test("the menu names the assistant and offers repair, retire, and cancel", () => {
  renderDialog();
  expect(screen.getByText(/authentication token for Office Mac/)).toBeDefined();
  expect(screen.getByRole("button", { name: "Wake & Repair" })).toBeDefined();
  expect(
    screen.getByRole("button", { name: "Retire Assistant" }),
  ).toBeDefined();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeDefined();
});

test("repair sits behind its own confirmation naming the token revocation", () => {
  renderDialog({ onRepair: () => {} });
  fireEvent.click(screen.getByRole("button", { name: "Wake & Repair" }));
  expect(screen.getByText("Repair Assistant?")).toBeDefined();
  expect(
    screen.getByText(/will be signed out and need to reconnect/),
  ).toBeDefined();
});

test("retire reuses the destructive retire confirmation", () => {
  renderDialog({ onRetire: () => {} });
  fireEvent.click(screen.getByRole("button", { name: "Retire Assistant" }));
  expect(screen.getByText(/permanently retire this assistant/i)).toBeDefined();
});

test("a repair failure's detail renders inline in the confirmation", () => {
  renderDialog({ errorMessage: "wake failed: gateway port unreachable" });
  fireEvent.click(screen.getByRole("button", { name: "Wake & Repair" }));
  expect(
    screen.getByText("wake failed: gateway port unreachable"),
  ).toBeDefined();
});
