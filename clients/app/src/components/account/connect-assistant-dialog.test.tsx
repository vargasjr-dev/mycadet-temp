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

interface HostCalls {
  start: Array<[string]>;
  poll: Array<[string, string?]>;
  cancel: string[];
  pollReplies: PollReply[];
}

const realFetch = globalThis.fetch;

function stubHost(): HostCalls {
  const calls: HostCalls = {
    start: [],
    poll: [],
    cancel: [],
    pollReplies: [],
  };
  const reply = (body: unknown) =>
    new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    });
  Object.defineProperty(window, "cadet", {
    configurable: true,
    value: { platform: "electron" },
  });
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const path = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : {};
    if (path.endsWith("/pairing-start")) {
      calls.start.push([(body as { address: string }).address]);
      return reply({
        ok: true,
        handle: "handle-1",
        userCode: "ABCD-1234",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        intervalSeconds: 0,
      });
    }
    if (path.endsWith("/pairing-poll")) {
      const poll = body as { handle: string; name?: string };
      calls.poll.push([poll.handle, poll.name]);
      // Replies exhausted: stay pending (1s cadence) rather than erroring —
      // an exhausted mock would error-state the dialog mid test, racing the
      // teardown this assertion pins.
      return reply(
        calls.pollReplies.shift() ?? {
          ok: true,
          status: "pending",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          intervalSeconds: 1,
        },
      );
    }
    if (path.endsWith("/pairing-cancel")) {
      calls.cancel.push((body as { handle: string }).handle);
      return reply({ ok: true });
    }
    return realFetch(input as string, init);
  }) as unknown as typeof fetch;
  return calls;
}

function clearHost(): void {
  if (originalCadet) {
    Object.defineProperty(window, "cadet", originalCadet);
  } else {
    Reflect.deleteProperty(window, "cadet");
  }
  globalThis.fetch = realFetch;
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
  clearHost();
  __resetConnectDialogForTesting();
});

test("renders the form and starts pairing with the pasted address", async () => {
  const calls = stubHost();
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
  const calls = stubHost();
  calls.start.length = 0;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        ok: false,
        error: "Address refused",
        rejection: "loopback",
      }),
      { headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;
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
  const calls = stubHost();
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
  const calls = stubHost();
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
