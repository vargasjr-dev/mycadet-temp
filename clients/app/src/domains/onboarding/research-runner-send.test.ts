/**
 * Tests for how the research runner opens its side conversation: it is minted
 * `background` so it never enters the foreground list, the prompt is posted
 * hidden (see `lib/side-conversation-message.ts`), and a resumed run re-posts
 * only when the turn never started. It also covers the archive that cleans the
 * thread up on every exit path, including one that never reaches the poll loop.
 *
 * Hidden rows are filtered out of `/messages`, so "did the prompt land?" reads
 * the turn's own state (still processing, or rows already produced) instead of
 * looking for a user row.
 *
 * NOTE: `bun mock.module` can leak across files. Run this file singly:
 *   bun test src/domains/onboarding/research-runner-send.test.ts
 */

import { createElement, type ReactNode } from "react";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, mock, test } from "bun:test";

import type { ResearchSubject } from "./research-prompt";

interface PostCall {
  assistantId: string;
  body: { conversationId: string; hidden?: boolean };
}

interface CreateCall {
  assistantId: string;
  body: { conversationType?: string; title?: string };
}

interface ArchiveCall {
  assistantId: string;
  conversationId: string;
}

let postCalls: PostCall[] = [];
let createCalls: CreateCall[] = [];
let archiveCalls: ArchiveCall[] = [];
let getCalls = 0;
let listed: { processing?: boolean; messages: unknown[] } = { messages: [] };
/** When set, the prompt POST fails, so the run gives up before the poll loop. */
let failMessagePost = false;
/** When set, createAssistantConversation waits here before resolving so a deadline can win. */
let createConversationHold: Promise<void> | null = null;

const ok = <T>(data: T) => Promise.resolve({ ok: true, status: 200, data });
const notOk = () =>
  Promise.resolve({
    ok: false,
    status: 500,
    error: { detail: "test failure" },
  });

mock.module("@app/gateway/daemon", () => ({
  searchAssistantPlugins: () => ok({ matches: [] }),
  installAssistantPlugin: () => ok({}),
  createAssistantConversation: async (
    assistantId: string,
    body: CreateCall["body"],
  ) => {
    createCalls.push({ assistantId, body });
    if (createConversationHold) {
      await createConversationHold;
    }
    return ok({ id: "conv-fresh" });
  },
  archiveAssistantConversation: (assistantId: string, conversationId: string) => {
    archiveCalls.push({ assistantId, conversationId });
    return ok({});
  },
  listAssistantMessages: () => {
    getCalls += 1;
    return ok(listed);
  },
  postAssistantMessage: (assistantId: string, body: PostCall["body"]) => {
    postCalls.push({ assistantId, body });
    return failMessagePost ? notOk() : ok({});
  },
}));
mock.module("@mycadet/design-library/utils/capture-error", () => ({
  captureError: () => {},
}));

const { useResearchRunner } =
  await import("./research-runner");

const subject: ResearchSubject = {
  firstName: "Alice",
  lastName: "Example",
  occupation: "Engineer",
  hobbies: [],
  timezone: "UTC",
};

function renderRunner() {
  const queryClient = new QueryClient();
  return renderHook(() => useResearchRunner(), {
    wrapper: ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children),
  });
}

afterEach(() => {
  postCalls = [];
  createCalls = [];
  archiveCalls = [];
  getCalls = 0;
  listed = { messages: [] };
  failMessagePost = false;
  createConversationHold = null;
});

/**
 * The resume branch reads `/messages` once and decides synchronously on the
 * result, so observing that read is enough to assert on the decision. The poll
 * loop's own reads are a poll interval away.
 */
async function whenResumeDecided(): Promise<void> {
  await waitFor(() => {
    expect(getCalls).toBeGreaterThan(0);
  });
}

describe("research prompt send", () => {
  test("mints the side conversation as background", async () => {
    // The regression this guards: a `standard` row is visible until the
    // end-of-run archive wins the race, so the user can land on a thread whose
    // only rendered content is an assistant intro.
    const { result } = renderRunner();

    act(() => {
      result.current.start({
        awaitAssistantId: async () => "ast-1",
        subject,
        conversationTitle: "Getting to know Alice",
      });
    });

    await waitFor(() => {
      expect(createCalls).toHaveLength(1);
    });
    expect(createCalls[0]?.body.conversationType).toBe("background");
    expect(createCalls[0]?.body.title).toBe("Getting to know Alice");

    act(() => {
      result.current.reset();
    });
  });

  test("posts the prompt as a hidden machine signal", async () => {
    const { result } = renderRunner();

    act(() => {
      result.current.start({
        awaitAssistantId: async () => "ast-1",
        subject,
      });
    });

    await waitFor(() => {
      expect(postCalls).toHaveLength(1);
    });
    expect(postCalls[0]?.body.conversationId).toBe("conv-fresh");
    expect(postCalls[0]?.body.hidden).toBe(true);

    act(() => {
      result.current.reset();
    });
  });

  test("re-posts on resume when the turn never started", async () => {
    const { result } = renderRunner();

    act(() => {
      result.current.start({
        awaitAssistantId: async () => "ast-1",
        subject,
        resumeConversationId: "conv-resumed",
      });
    });

    await waitFor(() => {
      expect(postCalls).toHaveLength(1);
    });
    expect(postCalls[0]?.body.conversationId).toBe("conv-resumed");

    act(() => {
      result.current.reset();
    });
  });

  test("does not re-post on resume while the turn is still processing", async () => {
    // The regression the hidden flag would otherwise cause: the prompt row is
    // filtered from `/messages`, so a user-row check would read "never landed"
    // and fire a second research turn on every refresh.
    listed = { processing: true, messages: [] };
    const { result } = renderRunner();

    act(() => {
      result.current.start({
        awaitAssistantId: async () => "ast-1",
        subject,
        resumeConversationId: "conv-resumed",
      });
    });

    await whenResumeDecided();
    expect(postCalls).toHaveLength(0);

    act(() => {
      result.current.reset();
    });
  });

  test("does not re-post on resume when the turn already produced rows", async () => {
    listed = {
      processing: false,
      messages: [{ role: "assistant", contentBlocks: [] }],
    };
    const { result } = renderRunner();

    act(() => {
      result.current.start({
        awaitAssistantId: async () => "ast-1",
        subject,
        resumeConversationId: "conv-resumed",
      });
    });

    await whenResumeDecided();
    expect(postCalls).toHaveLength(0);

    act(() => {
      result.current.reset();
    });
  });
});

describe("research wait budget", () => {
  test("a poll that never completes settles error when the budget expires", async () => {
    const { result } = renderRunner();

    act(() => {
      result.current.start({
        awaitAssistantId: async () => "ast-1",
        subject,
        timeoutMs: 40,
      });
    });

    await waitFor(() => {
      expect(result.current.status).toBe("error");
    });
    expect(result.current.claims).toEqual([]);
    expect(createCalls).toHaveLength(1);

    act(() => {
      result.current.reset();
    });
  });
});

describe("research conversation archive", () => {
  test("archives a conversation that lands after the research budget expires", async () => {
    let releaseCreate: () => void = () => {};
    createConversationHold = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const onConversationCreated = mock((_id: string) => {});
    const { result } = renderRunner();

    act(() => {
      result.current.start({
        awaitAssistantId: async () => "ast-1",
        subject,
        timeoutMs: 30,
        onConversationCreated,
      });
    });

    await waitFor(() => {
      expect(result.current.status).toBe("error");
    });
    expect(onConversationCreated).not.toHaveBeenCalled();
    expect(archiveCalls).toHaveLength(0);

    releaseCreate();

    await waitFor(() => {
      expect(archiveCalls).toHaveLength(1);
    });
    expect(archiveCalls[0]?.conversationId).toBe("conv-fresh");
    expect(onConversationCreated).not.toHaveBeenCalled();

    act(() => {
      result.current.reset();
    });
  });

  test("archives the side conversation when the prompt fails to post", async () => {
    // A failed prompt POST abandons the run before the poll loop, with the
    // conversation already minted. The archive is unconditional, so the
    // throwaway thread is cleaned up on this exit path like any other.
    failMessagePost = true;
    const { result } = renderRunner();

    act(() => {
      result.current.start({
        awaitAssistantId: async () => "ast-1",
        subject,
      });
    });

    await waitFor(() => {
      expect(archiveCalls).toHaveLength(1);
    });
    expect(archiveCalls[0]?.conversationId).toBe("conv-fresh");

    act(() => {
      result.current.reset();
    });
  });
});
