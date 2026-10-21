import { afterEach, expect, spyOn, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { ConnectAssistantDialog } from "./connect-assistant-dialog";
import {
  __resetConnectDialogForTesting,
  useConnectDialogStore,
} from "@app/stores/connect-dialog-store";

type PollReply =
  | { ok: true; status: "pending"; expiresAt: string; intervalSeconds: number }
  | {
      ok: true;
      status: "imported";
      assistantId: string;
      accessOnly: boolean;
    }
  | { ok: false; error: string; reason?: string };

const originalCadet = Object.getOwnPropertyDescriptor(window, "cadet");

interface BridgeCalls {
  start: Array<[string]>;
  poll: Array<[string, string?]>;
  cancel: string[];
  pollReplies: PollReply[];
}

function stubBridge(): BridgeCalls {
  const calls: BridgeCalls = {
    start: [],
    poll: [],
    cancel: [],
    pollReplies: [],
  };
  Object.defineProperty(window, "cadet", {
    configurable: true,
    value: {
      platform: "electron",
      localMode: {
        pairingStart: async (address: string) => {
          calls.start.push([address]);
          return {
            ok: true,
            handle: "handle-1",
            userCode: "ABCD-1234",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            intervalSeconds: 0,
          };
        },
        pairingPoll: async (handle: string, name?: string) => {
          calls.poll.push([handle, name]);
          const reply = calls.pollReplies.shift();
          if (!reply) {
            throw new Error("unexpected poll");
          }
          return reply;
        },
        pairingCancel: async (handle: string) => {
          calls.cancel.push(handle);
          return { ok: true };
        },
      },
    },
  });
  return calls;
}

function clearBridge(): void {
  if (originalCadet) {
    Object.defineProperty(window, "cadet", originalCadet);
  } else {
    Reflect.deleteProperty(window, "cadet");
  }
}

function renderDialog(
  props: {
    onImported?: (assistantId: string) => void;
    initialAddress?: string;
  } = {},
) {
  return render(
    <ConnectAssistantDialog
      open
      initialAddress={props.initialAddress}
      onClose={() => {}}
      onImported={props.onImported ?? (() => {})}
    />,
  );
}

afterEach(() => {
  cleanup();
  clearBridge();
  __resetConnectDialogForTesting();
});

test("renders the form and starts pairing with the pasted address", async () => {
  const calls = stubBridge();
  calls.pollReplies.push({
    ok: true,
    status: "imported",
    assistantId: "a-1",
    accessOnly: false,
  });
  renderDialog({
    onImported: (id) =>
      useConnectDialogStore
        .getState()
        .openConnectDialog({ initialAddress: id }),
  });

  fireEvent.change(await screen.findByLabelText("Address or pairing link"), {
    target: { value: "https://office.example.com" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));

  await waitFor(() => {
    expect(calls.start).toEqual([["https://office.example.com"]]);
  });
  // The approval code swaps in for the form while the poll loop runs.
  expect(await screen.findByText("ABCD-1234")).toBeDefined();
  await waitFor(() => {
    expect(useConnectDialogStore.getState().initialAddress).toBe("a-1");
  });
});

test("a refused address renders the structured rejection copy inline", async () => {
  const calls = stubBridge();
  calls.start.length = 0;
  Object.defineProperty(window, "cadet", {
    configurable: true,
    value: {
      platform: "electron",
      localMode: {
        pairingStart: async () => ({
          ok: false,
          error: "Address refused",
          rejection: "loopback",
        }),
      },
    },
  });
  renderDialog();

  fireEvent.change(await screen.findByLabelText("Address or pairing link"), {
    target: { value: "http://127.0.0.1:7830" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));

  expect(await screen.findByText(/loopback address/)).toBeDefined();
  // The form stays up for a corrected paste.
  expect(screen.getByLabelText("Address or pairing link")).toBeDefined();
});

test("an access-only import interposes the expiry warning before completing", async () => {
  const calls = stubBridge();
  calls.pollReplies.push({
    ok: true,
    status: "imported",
    assistantId: "a-1",
    accessOnly: true,
  });
  let imported: string | null = null;
  renderDialog({ onImported: (id) => (imported = id) });

  fireEvent.change(await screen.findByLabelText("Address or pairing link"), {
    target: { value: "https://office.example.com" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));

  expect(await screen.findByText("Pairing Imported")).toBeDefined();
  // The warning holds the connect until acknowledged.
  expect(imported).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await waitFor(() => {
    expect(imported).toBe("a-1");
  });
});

test("a dismissed dialog cancels the host session so the code cannot be exchanged", async () => {
  const calls = stubBridge();
  calls.pollReplies.push({
    ok: true,
    status: "pending",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    intervalSeconds: 0,
  });
  const { unmount } = renderDialog();

  fireEvent.change(await screen.findByLabelText("Address or pairing link"), {
    target: { value: "https://office.example.com" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  await screen.findByText("ABCD-1234");
  unmount();
  await waitFor(() => {
    expect(calls.cancel).toEqual(["handle-1"]);
  });
});
