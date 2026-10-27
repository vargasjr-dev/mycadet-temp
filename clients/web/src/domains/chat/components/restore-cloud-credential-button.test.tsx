import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";

import * as identity from "@/lib/local-cloud-identity";
import * as actualToast from "@mycadet/design-library/components/toast";

const recoverMock = mock(async () => {});
const toastSuccess = mock((_message: string) => {});
const toastError = mock((_message: string) => {});

mock.module("@/lib/local-cloud-identity", () => ({
  ...identity,
  recoverLocalAssistantCloudCredential: recoverMock,
}));

// The design-library barrel re-exports this module in full, so the stub keeps
// its other exports and replaces only the notifier.
mock.module("@mycadet/design-library/components/toast", () => ({
  ...actualToast,
  toast: { success: toastSuccess, error: toastError },
}));

mock.module("@/lib/error-reporting/capture-error", () => ({
  captureError: () => {},
}));

const { RestoreCloudCredentialButton } =
  await import("./restore-cloud-credential-button");

function renderButton(onRestored = mock(() => {})) {
  render(
    <MemoryRouter>
      <RestoreCloudCredentialButton onRestored={onRestored} />
    </MemoryRouter>,
  );
  return { onRestored, button: screen.getByRole("button") };
}

beforeEach(() => {
  recoverMock.mockReset();
  recoverMock.mockImplementation(async () => {});
  toastSuccess.mockClear();
  toastError.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("RestoreCloudCredentialButton", () => {
  test("with a cloud session, a press runs the repair and retires the banner on success", async () => {
    const { onRestored, button } = renderButton();

    fireEvent.click(button);

    await waitFor(() => expect(onRestored).toHaveBeenCalledTimes(1));
    expect(recoverMock).toHaveBeenCalledTimes(1);
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(toastError).not.toHaveBeenCalled();
  });

  // A failed repair leaves the banner in place to try again, and the reader
  // gets the typed reason, never the thrown text.
  test("a typed failure reports it and keeps the banner", async () => {
    recoverMock.mockImplementation(async () => {
      throw new identity.LocalCloudCredentialRecoveryError(
        "replacement_rejected",
        "platform said no",
      );
    });
    const { onRestored, button } = renderButton();

    fireEvent.click(button);

    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    expect(toastError.mock.calls[0]?.[0]).not.toContain("platform said no");
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(onRestored).not.toHaveBeenCalled();
  });
});
