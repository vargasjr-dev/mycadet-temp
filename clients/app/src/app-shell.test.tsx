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
import { AppShell } from "@app/app-shell";
import { changeLocale } from "@app/i18n";

// The shell derives its origin from the page — same-origin by construction.
const origin = window.location.origin;
const resolution = (id = "assistant-1") => ({
  status: "ready",
  assistant: {
    id,
    version: "1.2.3",
    url: "https://runtime.example.com/web/1.2.3/assistant/",
  },
});
const request = spyOn(globalThis, "fetch");
function respond(
  implementation: (
    ...args: Parameters<typeof fetch>
  ) => ReturnType<typeof fetch>,
) {
  request.mockImplementation(
    Object.assign(implementation, { preconnect: fetch.preconnect }),
  );
}
const navigate = mock((_path: string, _options: { replace: boolean }) => {});
afterEach(() => {
  cleanup();
  request.mockReset();
  navigate.mockClear();
});
function json(value: unknown) {
  return new Response(JSON.stringify(value));
}
function props(id: string | undefined = "assistant-1") {
  return {
    assistantId: id,
    location: "/admin/assistant/conversations/123?tab=files#last",
    mountPath: "/admin/assistant",
    onNavigate: navigate,
  };
}
function iframe(): HTMLIFrameElement {
  const frame = screen.getByTitle("Assistant");
  if (!(frame instanceof HTMLIFrameElement)) {
    throw new Error("Missing frame");
  }
  return frame;
}
function message(
  frame: HTMLIFrameElement,
  path: string,
  extra: { origin?: string; source?: Window; nav?: string } = {},
) {
  window.dispatchEvent(
    new MessageEvent("message", {
      source: extra.source ?? frame.contentWindow,
      origin: extra.origin ?? "https://runtime.example.com",
      data: { source: "mycadet-web-nav", nav: extra.nav ?? "push", path },
    }),
  );
}
async function mounted() {
  respond(async () => json(resolution()));
  const view = render(<AppShell {...props()} />);
  await waitFor(() => expect(screen.queryByTitle("Assistant")).not.toBeNull());
  await act(async () => {});
  return view;
}

test("server rendering never fetches or mounts a browser router", () => {
  expect(renderToString(<AppShell {...props()} />)).toContain(
    "Loading assistant",
  );
  expect(request).not.toHaveBeenCalled();
});

test("admin deep links and active-frame navigation preserve the host prefix", async () => {
  await mounted();
  const frame = iframe();
  expect(frame.src).toBe(
    "https://runtime.example.com/web/1.2.3/assistant/conversations/123?tab=files#last",
  );
  message(frame, "/assistant/settings?tab=profile#name");
  expect(navigate).toHaveBeenCalledWith(
    "/admin/assistant/settings?tab=profile#name",
    { replace: false },
  );
  message(frame, "/web/1.2.3/assistant/files", { nav: "pop" });
  expect(navigate).toHaveBeenLastCalledWith("/admin/assistant/files", {
    replace: true,
  });
});

test("rejects messages from other origins, windows, versions, or paths", async () => {
  await mounted();
  const frame = iframe();
  message(frame, "/assistant/settings", {
    origin: "https://elsewhere.example",
  });
  message(frame, "/assistant/settings", { source: window });
  for (const path of [
    "/account/login",
    "/web/2.0.0/assistant/settings",
    "/assistant/../account",
    "//elsewhere.example/assistant",
  ]) {
    message(frame, path);
  }
  expect(navigate).not.toHaveBeenCalled();
});

test("host navigation updates the active frame without another API lookup", async () => {
  const view = await mounted();
  const frame = iframe();
  if (!frame.contentWindow) {
    throw new Error("No frame window");
  }
  const post = spyOn(frame.contentWindow, "postMessage");
  const src = frame.src;
  view.rerender(
    <AppShell {...props()} location="/admin/assistant/identity?edit=1#name" />,
  );
  expect(iframe()).toBe(frame);
  expect(frame.src).toBe(src);
  expect(request).toHaveBeenCalledTimes(1);
  expect(post).toHaveBeenCalledWith(
    {
      source: "mycadet-web-parent-nav",
      path: "/web/1.2.3/assistant/identity?edit=1#name",
    },
    "https://runtime.example.com",
  );
  post.mockRestore();
});

for (const [status, message] of [
  [401, "Please sign in to continue."],
  [409, "Your assistant isn't ready."],
  [410, "This assistant is unavailable."],
  [200, "We couldn't reach your assistant"],
] as const) {
  test(`does not mount an iframe for HTTP ${status}`, async () => {
    respond(async () => new Response("{}", { status }));
    render(<AppShell {...props()} />);
    await screen.findByText(message);
    expect(screen.queryByTitle("Assistant")).toBeNull();
  });
}

test("wakes a not-ready assistant and mounts it once ready", async () => {
  request
    .mockResolvedValueOnce(new Response(null, { status: 409 }))
    .mockResolvedValueOnce(json({ ok: true, action: "woke", output: "" }))
    .mockResolvedValueOnce(json(resolution()));
  render(<AppShell {...props()} />);
  await screen.findByText("Your assistant isn't ready.");
  fireEvent.click(screen.getByRole("button", { name: "Wake it up" }));
  await screen.findByTitle("Assistant");
  expect(request).toHaveBeenCalledTimes(3);
  const wakeCall = request.mock.calls.find(([url]) =>
    String(url).endsWith("/v1/assistants/assistant-1/wake/"),
  );
  expect(wakeCall?.[1]?.method).toBe("POST");
});

test("a failed wake shows the node's own punchline and offers the wake again", async () => {
  request
    .mockResolvedValueOnce(new Response(null, { status: 409 }))
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: "hatch_failed",
          reason: "Firecracker exited with error",
        }),
        { status: 502 },
      ),
    );
  render(<AppShell {...props()} />);
  await screen.findByText("Your assistant isn't ready.");
  fireEvent.click(screen.getByRole("button", { name: "Wake it up" }));
  await screen.findByText("Firecracker exited with error");
  expect(request).toHaveBeenCalledTimes(2);
  expect(screen.queryByTitle("Assistant")).toBeNull();
});

test("retries an API failure without account session probes", async () => {
  request
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(json(resolution()));
  render(<AppShell {...props()} />);
  await screen.findByText("We couldn't reach your assistant");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByTitle("Assistant");
  expect(request).toHaveBeenCalledTimes(2);
  expect(
    request.mock.calls.every(([url]) => String(url).endsWith("/v1/assistant")),
  ).toBe(true);
});

test("an API failure offers switching to another assistant", async () => {
  respond(async () => new Response(null, { status: 503 }));
  render(<AppShell {...props()} />);
  await screen.findByText("We couldn't reach your assistant");
  fireEvent.click(screen.getByRole("button", { name: "Switch assistant" }));
  expect(navigate).toHaveBeenCalledWith("/account/select-assistant", {
    replace: false,
  });
});

test("unmount aborts requests and ignores late replies", async () => {
  let finish!: (value: Response) => void;
  respond(
    () =>
      new Promise((done) => {
        finish = done;
      }),
  );
  const view = render(<AppShell {...props()} />);
  await act(async () => {});
  const signal = request.mock.calls[0][1]?.signal;
  view.unmount();
  expect(signal?.aborted).toBe(true);
  await act(async () => {
    finish(json(resolution()));
  });
  expect(screen.queryByTitle("Assistant")).toBeNull();
});

test("changing assistant or API base immediately hides the previous frame", async () => {
  const view = await mounted();
  let finish!: (value: Response) => void;
  respond(() => {
    return new Promise((done) => {
      finish = done;
    });
  });
  view.rerender(
    <AppShell {...props("assistant-2")} apiBaseUrl="/admin/api/" />,
  );
  expect(screen.queryByTitle("Assistant")).toBeNull();
  await act(async () => {});
  expect(String(request.mock.calls.at(-1)?.[0])).toBe(
    `${origin}/admin/api/v1/assistant`,
  );
  await act(async () => {
    finish(json(resolution("assistant-2")));
  });
  await screen.findByTitle("Assistant");
});

test("without an ID the shell hands off to the account chooser", async () => {
  respond(async () =>
    json({
      status: "selection",
      assistants: [
        { id: "assistant-1", name: "One" },
        { id: "assistant-2", name: "Two" },
      ],
    }),
  );
  render(<AppShell {...props()} assistantId={undefined} />);
  await screen.findByText("Choose an assistant.");
  // The chooser handoff is a post-paint effect: await it rather than race it.
  await waitFor(() =>
    expect(navigate).toHaveBeenCalledWith("/account/select-assistant", {
      replace: true,
    }),
  );
  expect(screen.queryByRole("button", { name: "Two" })).toBeNull();
});

test("empty and unauthenticated states hand off to the chooser too", async () => {
  respond(async () => json({ status: "empty" }));
  render(<AppShell {...props()} assistantId={undefined} />);
  await screen.findByText("No assistant is available.");
  await waitFor(() =>
    expect(navigate).toHaveBeenCalledWith("/account/select-assistant", {
      replace: true,
    }),
  );
});

test("embedded shells follow the app locale", async () => {
  respond(async () => json({ status: "empty" }));
  await changeLocale("es");
  try {
    const first = render(<AppShell {...props()} assistantId={undefined} />);
    const second = render(<AppShell {...props()} assistantId={undefined} />);
    await waitFor(() => {
      for (const view of [first, second]) {
        expect(view.container.textContent).toContain(
          "No hay ningún asistente disponible.",
        );
      }
    });
  } finally {
    await changeLocale("en");
    localStorage.removeItem("device:locale");
  }
});

test("a late reply for a previous assistant cannot replace the current selection", async () => {
  // One resolution endpoint now — every request lands on the same URL, so
  // the pending requests are told apart by ORDER, not by path.
  const replies: Array<(response: Response) => void> = [];
  respond(() => {
    return new Promise((done) => {
      replies.push(done);
    });
  });
  const view = render(<AppShell {...props()} />);
  await act(async () => {});
  view.rerender(<AppShell {...props("assistant-2")} />);
  await act(async () => {});
  expect(replies.length).toBe(2);
  await act(async () => {
    replies[0]?.(json(resolution()));
  });
  expect(screen.queryByTitle("Assistant")).toBeNull();
  await act(async () => {
    replies[1]?.(json(resolution("assistant-2")));
  });
  await screen.findByTitle("Assistant");
});

test("frame navigation echoes do not create duplicate host history entries", async () => {
  await mounted();
  const frame = iframe();
  message(frame, "/assistant/files");
  message(frame, "/assistant/files");
  expect(navigate).toHaveBeenCalledTimes(1);
});

test("a frame that loads late receives the latest host route", async () => {
  const view = await mounted();
  const frame = iframe();
  if (!frame.contentWindow) {
    throw new Error("Missing frame window");
  }
  const post = spyOn(frame.contentWindow, "postMessage");
  view.rerender(
    <AppShell {...props()} location="/admin/assistant/files?view=grid#last" />,
  );
  post.mockClear();
  fireEvent.load(frame);
  expect(post).toHaveBeenCalledWith(
    {
      source: "mycadet-web-parent-nav",
      path: "/web/1.2.3/assistant/files?view=grid#last",
    },
    "https://runtime.example.com",
  );
  post.mockRestore();
});
