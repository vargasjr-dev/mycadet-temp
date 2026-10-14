/**
 * Integration tests for workspace-path spans rendered through
 * ChatMarkdownMessage.
 *
 * The span renders as a link unconditionally: no listing query backs it and
 * no existence check runs, so the tests assert the render itself plus the one
 * global invariant — that rendering a transcript never requests
 * `workspace/tree` (the old existence check was the only API reader here).
 * Click-through behavior is shared with explicit file links, so it is
 * asserted once.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

import { ChatMarkdownMessage } from "@/domains/chat/components/chat-markdown-message";
import { useViewerStore } from "@/stores/viewer-store";

const ASSISTANT_ID = "assistant-1";

function renderMessage(
  content: string,
  {
    workspacePathLinks = true,
    onCadetLinkClick = mock(() => {}),
  }: {
    workspacePathLinks?: boolean;
    onCadetLinkClick?: (href: string, linkText: string) => void;
  } = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  render(
    createElement(ChatMarkdownMessage, {
      content,
      assistantId: ASSISTANT_ID,
      workspacePathLinks,
      onCadetLinkClick,
    }),
    { wrapper },
  );
  return { onCadetLinkClick, queryClient };
}

/** Record every fetch URL the render provokes, answering them with a 200. */
function spyFetch(): { urls: string[]; restore: () => void } {
  const client = globalThis.fetch;
  const urls: string[] = [];
  const impl = (input: string | URL | Request): Promise<Response> => {
    urls.push(String(input instanceof Request ? input.url : input));
    return Promise.resolve(new Response("{}", { status: 200 }));
  };
  // bun-types' `typeof fetch` requires a `preconnect` member, so the plain
  // impl gets one attached to satisfy the assignment.
  globalThis.fetch = Object.assign(impl, { preconnect: () => {} });
  return { urls, restore: () => (globalThis.fetch = client) };
}

afterEach(() => {
  cleanup();
  // A resolved span opens the real drawer, so each test starts from a closed
  // one.
  useViewerStore.getState().reset();
});

describe("workspace path spans", () => {
  test("a workspace path renders as a clickable link", () => {
    renderMessage("The draft is at `/workspace/drafts/v0.10.12-release-notes.md`.");

    const button = screen.getByRole("button", {
      name: "/workspace/drafts/v0.10.12-release-notes.md",
    });
    expect(button).toBeTruthy();
  });

  test("a path whose file does not exist still renders as a link", () => {
    // The "I'll write it to X" case: the span is path-shaped, but nothing is
    // there yet. It links anyway — the check moved to click time, where the
    // drawer shows its not-found state, because render-time verification cost
    // a listing per directory (and polls for paths that could never resolve).
    renderMessage("I'll write it to `/workspace/drafts/notes.md`.");

    const button = screen.getByRole("button", {
      name: "/workspace/drafts/notes.md",
    });
    expect(button).toBeTruthy();
  });

  test("clicking opens the file in the drawer, like an explicit link", () => {
    const { onCadetLinkClick } = renderMessage("See `/workspace/drafts/deck.pdf`.");

    screen.getByRole("button", { name: "/workspace/drafts/deck.pdf" }).click();

    expect(useViewerStore.getState().openedDocumentState).toEqual({
      source: "workspace-file-preview",
      workspacePath: "drafts/deck.pdf",
      documentName: "deck.pdf",
      previewKind: "pdf",
    });
    expect(onCadetLinkClick).not.toHaveBeenCalled();
  });

  test("rendering a transcript never requests the workspace tree", () => {
    // The old existence check listed every span's parent directory — deduped
    // per directory, polled while unresolved. Links are now unconditional, so
    // even a transcript full of path spans must fetch nothing.
    const { urls, restore } = spyFetch();
    try {
      renderMessage(
        [
          "Moved `terraform/main.tf` into `services/cloud-api/`, and",
          "`@mycadet/cloud` now resolves. Planned: `/workspace/drafts/notes.md`.",
        ].join(" "),
      );

      expect(
        screen.getAllByRole("button", { name: "terraform/main.tf" }).length,
      ).toBeGreaterThan(0);
      expect(urls.filter((url) => url.includes("/tree"))).toEqual([]);
    } finally {
      restore();
    }
  });

  test("user-authored content is never upgraded", () => {
    // A path the user typed is their own prose — it renders as written.
    renderMessage("See `/workspace/drafts/notes.md`.", {
      workspacePathLinks: false,
    });

    expect(screen.queryByRole("button")).toBeNull();
  });

  test("paths inside fenced code blocks are left alone", () => {
    renderMessage("```\n/workspace/drafts/notes.md\n```");

    // Scoped by name: the code block ships its own copy button.
    expect(
      screen.queryByRole("button", { name: "/workspace/drafts/notes.md" }),
    ).toBeNull();
  });
});
