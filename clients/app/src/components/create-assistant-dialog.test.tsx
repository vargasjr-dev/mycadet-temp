import { afterEach, expect, mock, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { CreateCloudAssistantResult } from "@app/assistant/create-cloud-assistant";

const createCloudAssistant = mock(
  async (_name?: string): Promise<CreateCloudAssistantResult> => ({
    ok: true,
    id: "assistant-new",
  }),
);
mock.module("@app/assistant/create-cloud-assistant", () => ({
  createCloudAssistant,
}));
const { CreateAssistantDialog } = await import("./create-assistant-dialog");
afterEach(() => {
  cleanup();
  createCloudAssistant.mockClear();
});

test("the app dialog trims the name and prevents duplicate creation while pending", async () => {
  let resolve!: (value: CreateCloudAssistantResult) => void;
  createCloudAssistant.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const onClose = mock(() => {});
  render(<CreateAssistantDialog open onClose={onClose} />);
  const input = screen.getByPlaceholderText("Assistant name (optional)");
  fireEvent.change(input, { target: { value: "  Example  " } });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  expect(createCloudAssistant).toHaveBeenCalledWith("Example");
  expect(
    screen.getByRole("button", { name: "Create" }).hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(createCloudAssistant).toHaveBeenCalledTimes(1);
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => {
    resolve({ ok: true, id: "assistant-new" });
  });
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("a failed creation leaves the dialog open and allows retry with an optional name", async () => {
  createCloudAssistant.mockResolvedValueOnce({
    ok: false,
    error: "Assistant limit reached.",
  });
  const onClose = mock(() => {});
  render(<CreateAssistantDialog open onClose={onClose} />);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
  });
  expect(createCloudAssistant).toHaveBeenCalledWith(undefined);
  expect(onClose).not.toHaveBeenCalled();
  expect(
    screen.getByRole("button", { name: "Create" }).hasAttribute("disabled"),
  ).toBe(false);
});
