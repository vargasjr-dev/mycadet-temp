import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";

import {
  normalizeOriginUrl,
  type AddOriginResult,
  type RememberedOrigin,
} from "@app/stores/remembered-origins-store";

// --- Mutable per-test state, reset in beforeEach ------------------------------

const addOriginMock = mock(
  async (input: { url: string; name?: string }): Promise<AddOriginResult> => ({
    ok: true,
    origin: { url: input.url, addedAt: "2026-01-01T00:00:00.000Z" },
  }),
);

const onCloseMock = mock(() => {});
const onAddedMock = mock(
  (_origin: RememberedOrigin, _deviceCode: string | null) => {},
);

// --- Mocks --------------------------------------------------------------------

// Only the store's action is stubbed; the real `normalizeOriginUrl` is handed
// back through the mock, since it is the dialog's acceptance gate. Bun keeps
// the static-import binding above pointing at the real implementation, so this
// re-export is not a cycle.
mock.module("@app/stores/remembered-origins-store", () => ({
  normalizeOriginUrl,
  useRememberedOriginsStore: {
    getState: () => ({ addOrigin: addOriginMock }),
  },
}));

mock.module("@mycadet/design-library/components/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children?: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));

mock.module("@mycadet/design-library/components/input", () => ({
  Input: ({
    fullWidth: _fullWidth,
    ...props
  }: ComponentProps<"input"> & { fullWidth?: boolean }) => <input {...props} />,
}));

mock.module("@mycadet/design-library/components/modal", () => ({
  Modal: {
    Root: ({ open, children }: { open: boolean; children: ReactNode }) =>
      open ? <div>{children}</div> : null,
    Content: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    Header: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    Title: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
    Description: ({ children }: { children: ReactNode }) => <p>{children}</p>,
    Body: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    Footer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  },
}));

const { AddRemoteOriginDialog } = await import("./add-remote-origin-dialog");

// --- Helpers ------------------------------------------------------------------

// The catalog copy each refusal renders, so a hardcoded English string
// reappearing in the component fails here.
const NON_HTTPS_COPY =
  "The URL must use https so your devices can connect securely.";
const UNPARSEABLE_COPY =
  "Enter a valid URL, e.g. https://your-assistant.ts.net.";
const FAILED_COPY = "Failed to add the assistant. Please try again.";

function renderDialog(
  overrides: Partial<ComponentProps<typeof AddRemoteOriginDialog>> = {},
) {
  return render(
    <AddRemoteOriginDialog
      open
      onClose={onCloseMock}
      onAdded={onAddedMock}
      {...overrides}
    />,
  );
}

function fillAddress(value: string): void {
  fireEvent.change(screen.getByLabelText("Assistant address"), {
    target: { value },
  });
}

// --- Suite --------------------------------------------------------------------

describe("AddRemoteOriginDialog", () => {
  beforeEach(() => {
    addOriginMock.mockClear();
    addOriginMock.mockImplementation(async (input) => ({
      ok: true,
      origin: { url: input.url, addedAt: "2026-01-01T00:00:00.000Z" },
    }));
    onCloseMock.mockClear();
    onAddedMock.mockClear();
  });
  afterEach(() => cleanup());

  test("renders with the add button disabled while the address is empty", () => {
    renderDialog();
    expect(
      screen.getByRole("button", { name: "Add" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  test("a bare https base stores the base and completes via onAdded with no device code", async () => {
    renderDialog();
    fillAddress("https://Host.Example/prefix/");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
    });
    expect(addOriginMock).toHaveBeenCalledWith({
      url: "https://host.example/prefix",
    });
    expect(onAddedMock).toHaveBeenCalledWith(
      {
        url: "https://host.example/prefix",
        addedAt: "2026-01-01T00:00:00.000Z",
      },
      null,
    );
  });

  test("a pasted pairing link stores only the base and hands the fragment's device code to the caller", async () => {
    renderDialog();
    fillAddress("https://host.example/assistant/pair#device_code=CODE-1");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
    });
    expect(addOriginMock).toHaveBeenCalledWith({ url: "https://host.example" });
    expect(onAddedMock.mock.calls[0]?.[1]).toBe("CODE-1");
  });

  test("a query-string device code is read the same way", async () => {
    renderDialog();
    fillAddress("https://host.example/assistant/pair?device_code=CODE-2");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
    });
    expect(onAddedMock.mock.calls[0]?.[1]).toBe("CODE-2");
  });

  test("a non-https address renders that refusal and never touches the store", async () => {
    renderDialog();
    fillAddress("http://host.example");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
    });
    expect(screen.getByText(NON_HTTPS_COPY)).toBeTruthy();
    expect(addOriginMock).not.toHaveBeenCalled();
    expect(onAddedMock).not.toHaveBeenCalled();
  });

  test("an unparseable address renders its refusal", async () => {
    renderDialog();
    fillAddress("not a url");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
    });
    expect(screen.getByText(UNPARSEABLE_COPY)).toBeTruthy();
    expect(addOriginMock).not.toHaveBeenCalled();
  });

  test("a tunnel vendor's website is refused by name", async () => {
    renderDialog();
    fillAddress("https://ngrok.com");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
    });
    expect(screen.getByText(/ngrok's website/)).toBeTruthy();
    expect(addOriginMock).not.toHaveBeenCalled();
  });

  test("a store failure keeps the dialog open with its copy", async () => {
    addOriginMock.mockResolvedValue({ ok: false });
    renderDialog();
    fillAddress("https://host.example");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
    });
    expect(screen.getByText(FAILED_COPY)).toBeTruthy();
    expect(onCloseMock).not.toHaveBeenCalled();
    expect(onAddedMock).not.toHaveBeenCalled();
  });

  test("a pending add disables the buttons and guards re-entry", async () => {
    let resolve!: (value: AddOriginResult) => void;
    addOriginMock.mockImplementationOnce(
      () =>
        new Promise<AddOriginResult>((done) => {
          resolve = done;
        }),
    );
    renderDialog();
    fillAddress("https://host.example");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
    });
    expect(
      screen.getByRole("button", { name: "Adding…" }).hasAttribute("disabled"),
    ).toBe(true);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Adding…" }));
    });
    expect(addOriginMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolve({
        ok: true,
        origin: {
          url: "https://host.example",
          addedAt: "2026-01-01T00:00:00.000Z",
        },
      });
    });
    expect(onAddedMock).toHaveBeenCalledTimes(1);
  });
});
