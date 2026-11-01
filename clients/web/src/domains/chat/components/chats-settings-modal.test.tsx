import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import {
  ChatsSettingsModal,
  type ChatsSettingsModalProps,
} from "./chats-settings-modal";
import type { ChatsSettingsValues } from "./chats-settings-form";

const DEFAULTS: ChatsSettingsValues = {
  newMessageEnabled: true,
};

afterEach(cleanup);

function setup(overrides: Partial<ChatsSettingsModalProps> = {}) {
  const props: ChatsSettingsModalProps = {
    open: true,
    onOpenChange: mock(() => {}),
    state: { status: "ready", values: DEFAULTS },
    saveStatus: "idle",
    onSave: mock(() => {}),
    onRetryLoad: mock(() => {}),
    ...overrides,
  };
  const view = render(<ChatsSettingsModal {...props} />);
  return {
    ...view,
    props,
    update: (next: Partial<ChatsSettingsModalProps>) =>
      view.rerender(<ChatsSettingsModal {...props} {...next} />),
  };
}

function clickBackdrop() {
  const overlay = document.querySelector('[data-slot="modal-overlay"]')!;
  fireEvent.pointerDown(overlay);
  fireEvent.pointerUp(overlay);
  fireEvent.click(overlay);
}

describe("ChatsSettingsModal", () => {
  test("labels controls and starts with no writable changes", () => {
    const view = setup();
    expect(view.getByRole("dialog", { name: "Chats Settings" })).toBeDefined();
    const toggle = view.getByRole("switch", { name: "Chat reply alerts" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(
      view.getByRole("button", { name: "Confirm" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  test("Confirm submits only changed leaves and leaves closing to successful save", () => {
    const view = setup();
    fireEvent.click(view.getByRole("switch", { name: "Chat reply alerts" }));
    fireEvent.click(view.getByRole("button", { name: "Confirm" }));
    expect(view.props.onSave).toHaveBeenCalledTimes(1);
    expect(view.props.onSave).toHaveBeenCalledWith({
      notifications: { newMessageEnabled: false },
    });
    expect(view.props.onOpenChange).not.toHaveBeenCalled();
  });

  test("reverting the draft disables Confirm", () => {
    const view = setup();
    const toggle = view.getByRole("switch", {
      name: "Chat reply alerts",
    });
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    expect(
      view.getByRole("button", { name: "Confirm" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  test("a remote refresh preserves the draft and its opening comparison", () => {
    const view = setup();
    fireEvent.click(view.getByRole("switch", { name: "Chat reply alerts" }));
    view.update({
      state: {
        status: "ready",
        values: { newMessageEnabled: true },
      },
    });
    expect(
      view
        .getByRole("switch", { name: "Chat reply alerts" })
        .getAttribute("aria-checked"),
    ).toBe("false");
    fireEvent.click(view.getByRole("button", { name: "Confirm" }));
    expect(view.props.onSave).toHaveBeenCalledWith({
      notifications: { newMessageEnabled: false },
    });
  });

  test("Cancel discards edits and reopening uses the latest saved values", async () => {
    const view = setup();
    fireEvent.click(view.getByRole("switch", { name: "Chat reply alerts" }));
    fireEvent.click(view.getByRole("button", { name: "Cancel" }));
    expect(view.props.onOpenChange).toHaveBeenCalledWith(false);
    expect(view.props.onSave).not.toHaveBeenCalled();
    view.update({ open: false });
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
    view.update({
      state: {
        status: "ready",
        values: { newMessageEnabled: false },
      },
    });
    expect(
      view
        .getByRole("switch", { name: "Chat reply alerts" })
        .getAttribute("aria-checked"),
    ).toBe("false");
    expect(
      view.getByRole("button", { name: "Confirm" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  test.each(["escape", "backdrop"])("%s dismissal never saves", (method) => {
    const view = setup();
    fireEvent.click(view.getByRole("switch", { name: "Chat reply alerts" }));
    if (method === "escape") {
      fireEvent.keyDown(view.getByRole("dialog"), { key: "Escape" });
    } else {
      clickBackdrop();
    }
    expect(view.props.onOpenChange).toHaveBeenCalledWith(false);
    expect(view.props.onSave).not.toHaveBeenCalled();
  });

  test("pending save blocks duplicate submission and dismissal, then a failed save can retry", () => {
    const view = setup();
    fireEvent.click(view.getByRole("switch", { name: "Chat reply alerts" }));
    view.getByRole("button", { name: "Confirm" }).focus();
    fireEvent.click(view.getByRole("button", { name: "Confirm" }));
    view.update({ saveStatus: "pending" });
    const savingButton = view.getByRole("button", { name: "Saving…" });
    expect(savingButton.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(savingButton);
    expect(
      view
        .getByRole("switch", { name: "Chat reply alerts" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      view.getByRole("button", { name: "Cancel" }).hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.submit(view.getByRole("dialog").querySelector("form")!);
    fireEvent.keyDown(view.getByRole("dialog"), { key: "Escape" });
    clickBackdrop();
    expect(view.props.onSave).toHaveBeenCalledTimes(1);
    expect(view.props.onOpenChange).not.toHaveBeenCalled();
    expect(view.getByRole("status").textContent).toBe("Saving…");
    view.update({ saveStatus: "error" });
    expect(view.getByRole("alert").textContent).toContain(
      "Your changes are kept here",
    );
    expect(
      view
        .getByRole("switch", { name: "Chat reply alerts" })
        .getAttribute("aria-checked"),
    ).toBe("false");
    fireEvent.click(view.getByRole("button", { name: "Confirm" }));
    expect(view.props.onSave).toHaveBeenCalledTimes(2);
  });

  test.each(["loading", "error", "unsupported"] as const)(
    "%s cannot submit guessed preferences",
    (status) => {
      const view = setup({ state: { status } });
      expect(view.queryByRole("switch")).toBeNull();
      expect(
        view.getByRole("button", { name: "Confirm" }).hasAttribute("disabled"),
      ).toBe(true);
      if (status === "error") {
        fireEvent.click(view.getByRole("button", { name: "Retry" }));
        expect(view.props.onRetryLoad).toHaveBeenCalledTimes(1);
      }
      expect(view.props.onSave).not.toHaveBeenCalled();
    },
  );

  test("finishing load initializes the form from the fetched values", () => {
    const view = setup({ state: { status: "loading" } });
    view.update({
      state: {
        status: "ready",
        values: { newMessageEnabled: false },
      },
    });
    expect(
      view
        .getByRole("switch", { name: "Chat reply alerts" })
        .getAttribute("aria-checked"),
    ).toBe("false");
  });

  test("closing restores focus to the external settings button", async () => {
    const button = document.createElement("button");
    document.body.append(button);
    try {
      const view = setup({ returnFocusRef: { current: button } });
      view.update({ open: false });
      await waitFor(() => expect(document.activeElement).toBe(button));
    } finally {
      button.remove();
    }
  });
});
