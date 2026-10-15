import { afterEach, expect, mock, spyOn, test } from "bun:test";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  fireEvent,
} from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { AppShell } from "./index";
import type { ResolveAssistant } from "./assistant/resolution-contract";
const origin = "https://site.example.com";
const ready = (id = "assistant-1") => ({
  status: "ready",
  assistant: {
    id,
    ui: {
      version: "1.2.3",
      entryUrl: "https://runtime.example.com/web/1.2.3/assistant/",
    },
    runtime: { baseUrl: `/runtime/${id}/v1/` },
  },
});
const navigate = mock((_path: string, _options: { replace: boolean }) => {});
afterEach(() => {
  cleanup();
  navigate.mockClear();
});
function show(
  resolveAssistant: ResolveAssistant,
  location = "/admin/assistant/conversations/123?tab=files#last",
) {
  return render(
    <AppShell
      resolveAssistant={resolveAssistant}
      location={location}
      mountPath="/admin/assistant"
      origin={origin}
      onNavigate={navigate}
    />,
  );
}
function iframe(): HTMLIFrameElement {
  const frame = screen.getByTitle("Assistant");
  if (!(frame instanceof HTMLIFrameElement)) {
    throw new Error("Expected iframe");
  }
  return frame;
}
function message(
  frame: HTMLIFrameElement,
  path: string,
  options: { origin?: string; source?: Window; nav?: string } = {},
) {
  window.dispatchEvent(
    new MessageEvent("message", {
      source: options.source ?? frame.contentWindow,
      origin: options.origin ?? "https://runtime.example.com",
      data: { source: "mycadet-web-nav", nav: options.nav ?? "push", path },
    }),
  );
}
test("public entry server-renders without fetching or mounting a browser router", () => {
  const resolve = mock(async () => ready());
  expect(
    renderToString(
      <AppShell
        resolveAssistant={resolve}
        location="/assistant"
        origin={origin}
        onNavigate={navigate}
      />,
    ),
  ).toContain("Loading assistant");
  expect(resolve).not.toHaveBeenCalled();
});
test("mounts at the admin prefix and accepts navigation only from its active frame and exact origin", async () => {
  show(async () => ready());
  await waitFor(() => expect(screen.queryByTitle("Assistant")).not.toBeNull());
  await act(async () => {});
  const frame = iframe();
  expect(frame.src).toBe(
    "https://runtime.example.com/web/1.2.3/assistant/conversations/123?tab=files#last",
  );
  message(frame, "/assistant/settings", {
    origin: "https://other.example.com",
  });
  message(frame, "/assistant/settings", { source: window });
  message(frame, "/assistant-other");
  message(frame, "/assistant/%2e%2e/account");
  expect(navigate).not.toHaveBeenCalled();
  message(frame, "/web/1.2.3/assistant/settings?section=voice#input");
  expect(navigate).toHaveBeenLastCalledWith(
    "/admin/assistant/settings?section=voice#input",
    { replace: false },
  );
  message(frame, "/assistant/settings?section=voice#input");
  expect(navigate).toHaveBeenCalledTimes(1);
  message(frame, "/assistant/identity", { nav: "pop" });
  expect(navigate).toHaveBeenLastCalledWith("/admin/assistant/identity", {
    replace: true,
  });
});
test("host back and forward update the frame over the navigation protocol without remounting it", async () => {
  const resolve = mock(async () => ready());
  const view = show(resolve);
  await waitFor(() => expect(screen.queryByTitle("Assistant")).not.toBeNull());
  await act(async () => {});
  const frame = iframe();
  const content = frame.contentWindow;
  if (!content) {
    throw new Error("Expected frame window");
  }
  const post = spyOn(content, "postMessage");
  const src = frame.src;
  view.rerender(
    <AppShell
      resolveAssistant={resolve}
      location="/admin/assistant/identity?edit=1#name"
      mountPath="/admin/assistant"
      origin={origin}
      onNavigate={navigate}
    />,
  );
  expect(iframe()).toBe(frame);
  expect(frame.src).toBe(src);
  expect(resolve).toHaveBeenCalledTimes(1);
  expect(post).toHaveBeenCalledWith(
    {
      source: "mycadet-web-parent-nav",
      path: "/web/1.2.3/assistant/identity?edit=1#name",
    },
    "https://runtime.example.com",
  );
  post.mockRestore();
});
for (const result of [
  { status: "unauthenticated" },
  { status: "empty" },
  { status: "starting" },
  { status: "ready", assistant: {} },
]) {
  test(`does not mount assistant UI for ${JSON.stringify(result)}`, async () => {
    show(async () => result);
    await waitFor(() =>
      expect(screen.queryByText("Loading assistant…")).toBeNull(),
    );
    expect(screen.queryByTitle("Assistant")).toBeNull();
    expect(screen.getByRole("status")).toBeDefined();
  });
}
test("a failed resolution can be retried without any account auth store", async () => {
  const resolve = mock(async (): Promise<unknown> => {
    throw new Error("Unavailable");
  });
  resolve.mockImplementationOnce(async () => {
    throw new Error("Unavailable");
  });
  resolve.mockImplementationOnce(async () => ready());
  show(resolve);
  await waitFor(() =>
    expect(screen.queryByText("Unable to load assistant.")).not.toBeNull(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(screen.queryByTitle("Assistant")).not.toBeNull());
  expect(resolve).toHaveBeenCalledTimes(2);
});
test("unmount aborts resolution and ignores a late result", async () => {
  let finish!: (value: unknown) => void;
  let signal: AbortSignal | undefined;
  const resolve: ResolveAssistant = (request) => {
    signal = request.signal;
    return new Promise((done) => {
      finish = done;
    });
  };
  const view = show(resolve);
  await act(async () => {});
  view.unmount();
  expect(signal?.aborted).toBe(true);
  await act(async () => {
    finish(ready());
  });
  expect(screen.queryByTitle("Assistant")).toBeNull();
});
test("changing assistant identity hides the old frame immediately and rejects a mismatched resolution", async () => {
  const resolve = mock(async () => ready());
  const view = show(resolve);
  await waitFor(() => expect(screen.queryByTitle("Assistant")).not.toBeNull());
  view.rerender(
    <AppShell
      resolveAssistant={resolve}
      assistantId="assistant-2"
      location="/admin/assistant"
      mountPath="/admin/assistant"
      origin={origin}
      onNavigate={navigate}
    />,
  );
  expect(screen.queryByTitle("Assistant")).toBeNull();
  await waitFor(() =>
    expect(screen.queryByText("Unable to load assistant.")).not.toBeNull(),
  );
});

test("late results for a previous selection cannot mount that assistant", async () => {
  const pending = new Map<string, (value: unknown) => void>();
  const resolve: ResolveAssistant = ({ assistantId }) =>
    new Promise((done) => {
      pending.set(assistantId ?? "assistant-1", done);
    });
  const view = show(resolve);
  await act(async () => {});
  view.rerender(
    <AppShell
      resolveAssistant={resolve}
      assistantId="assistant-2"
      location="/admin/assistant"
      mountPath="/admin/assistant"
      origin={origin}
      onNavigate={navigate}
    />,
  );
  await act(async () => {});
  await act(async () => {
    pending.get("assistant-1")?.(ready());
  });
  expect(screen.queryByTitle("Assistant")).toBeNull();
  await act(async () => {
    pending.get("assistant-2")?.(ready("assistant-2"));
  });
  expect(screen.queryByTitle("Assistant")).not.toBeNull();
});

test("frame load receives the latest host path when navigation changes before loading finishes", async () => {
  const resolve = mock(async () => ready());
  const view = show(resolve);
  await waitFor(() => expect(screen.queryByTitle("Assistant")).not.toBeNull());
  await act(async () => {});
  const frame = iframe();
  const content = frame.contentWindow;
  if (!content) {
    throw new Error("Expected frame window");
  }
  const post = spyOn(content, "postMessage");
  view.rerender(
    <AppShell
      resolveAssistant={resolve}
      location="/admin/assistant/identity#name"
      mountPath="/admin/assistant"
      origin={origin}
      onNavigate={navigate}
    />,
  );
  post.mockClear();
  fireEvent.load(frame);
  expect(post).toHaveBeenCalledWith(
    {
      source: "mycadet-web-parent-nav",
      path: "/web/1.2.3/assistant/identity#name",
    },
    "https://runtime.example.com",
  );
  post.mockRestore();
});
