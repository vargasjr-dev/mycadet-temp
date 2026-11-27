import { requireElement } from "@/lib/require-element.test-helper";
/**
 * Tests for the `ChatBody` layout behavior.
 *
 * Verifies the conditional CSS class logic and slot rendering that
 * enables centered empty-state layout (LUM-1566): greeting + composer +
 * conversation-starter chips center as one visual group via
 * `justify-content: safe center`.
 *
 * Uses bun:test + react-dom/server (renderToStaticMarkup) matching the
 * existing project test convention. Complex child components are stubbed
 * via `mock.module` so the test focuses on the composition logic inside
 * `ChatBody` itself.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { type ButtonHTMLAttributes, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { normalizeQuestionRequest } from "@/domains/chat/api/event-types";
import { useInteractionStore } from "@/domains/chat/interaction-store";
import type { ChatBodyProps } from "@/domains/chat/components/chat-body";
import { useBannerVisibilityStore } from "@/stores/banner-visibility-store";

// Stub child components that require browser APIs or complex hooks.
// NOTE: Do NOT mock chat-scroll-area itself — that leaks across test
// files via bun's shared module registry and breaks chat-scroll-area's
// own tests. Instead, mock ChatScrollArea's deep dependencies.
mock.module("@/domains/chat/transcript/transcript", () => ({
  Transcript: () => <div data-testid="transcript">TRANSCRIPT</div>,
}));

mock.module("@/domains/chat/components/chat-skeleton", () => ({
  ChatSkeleton: () => <div>SKELETON</div>,
}));

mock.module("@/domains/chat/components/scroll-to-latest-button", () => ({
  ScrollToLatestButton: ({ onClick }: { onClick: () => void }) => (
    <button data-testid="scroll-to-latest" onClick={onClick}>
      SCROLL_TO_LATEST
    </button>
  ),
}));

mock.module("@mycadet/design-library", () => ({
  Button: ({
    children,
    iconOnly,
    leftIcon: _leftIcon,
    variant: _variant,
    size: _size,
    ...props
  }: {
    children?: ReactNode;
    iconOnly?: ReactNode;
    leftIcon?: ReactNode;
    variant?: string;
    size?: string;
  } & ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{iconOnly ?? children}</button>
  ),
  Notice: ({
    children,
    actions,
    tone,
    onDismiss,
  }: {
    children?: ReactNode;
    actions?: ReactNode;
    tone?: string;
    onDismiss?: () => void;
  }) => (
    <div data-testid="notice" data-tone={tone}>
      {children}
      {actions ? <div data-testid="notice-actions">{actions}</div> : null}
      {onDismiss ? (
        <button
          type="button"
          aria-label="Dismiss"
          data-testid="notice-dismiss"
          onClick={onDismiss}
        />
      ) : null}
    </div>
  ),
  Card: {
    Root: ({
      children,
      padding: _padding,
      bordered: _bordered,
      elevated: _elevated,
      ...props
    }: {
      children?: ReactNode;
      padding?: unknown;
      bordered?: unknown;
      elevated?: unknown;
    }) => <div {...props}>{children}</div>,
    Body: ({
      children,
      padding: _padding,
      ...props
    }: {
      children?: ReactNode;
      padding?: unknown;
    }) => <div {...props}>{children}</div>,
  },
  ResizablePanel: () => <div data-testid="resizable-panel" />,
  ScrollShadow: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  Typography: ({ children }: { children?: ReactNode }) => (
    <span>{children}</span>
  ),
}));

mock.module("@/domains/chat/refresh-feedback-pill", () => ({
  RefreshFeedbackPill: () => <div>REFRESH_PILL</div>,
}));

mock.module("@/domains/chat/components/question-prompt-card", () => ({
  QuestionPromptCard: () => <div data-testid="question-prompt-card" />,
}));

let keyboardOpen = false;
mock.module("@/hooks/use-keyboard-open", () => ({
  useKeyboardOpen: () => keyboardOpen,
}));

// Import after mocks are registered.
const { ChatBody } = await import("@/domains/chat/components/chat-body");

const noop = () => {};
const noopDrag = () => {};

function baseProps(overrides: Partial<ChatBodyProps> = {}): ChatBodyProps {
  return {
    variant: "main",
    scrollAreaProps: {
      isLoadingHistory: false,
      messageCount: 0,
      showEmptyState: false,
      emptyStateProps: {},
      transcriptRef: null,
      transcriptProps: { messages: [], onScrollToMessage: noop } as never,
    },
    composerSlot: <div data-testid="composer">COMPOSER</div>,
    dragHandlers: {
      onDragEnter: noopDrag,
      onDragOver: noopDrag,
      onDragLeave: noopDrag,
      onDrop: noopDrag,
    },
    isAttachmentDragOver: false,
    showScrollToLatest: false,
    onScrollToLatest: noop,
    refreshFeedback: null,
    onDismissRefreshFeedback: noop,
    onRetryRefresh: noop,
    genericChatError: null,
    ...overrides,
  };
}

function withEmptyState(overrides: Partial<ChatBodyProps> = {}): ChatBodyProps {
  return baseProps({
    scrollAreaProps: {
      ...baseProps().scrollAreaProps,
      showEmptyState: true,
    },
    ...overrides,
  });
}

describe("shared document presentation", () => {
  test("desktop help can reopen the transcript from a document without replacing the composer", () => {
    const question = normalizeQuestionRequest({
      type: "question_request",
      requestId: "req-help",
      question: "Complete verification.",
      options: [{ id: "done", label: "Done" }],
      questions: [
        {
          id: "q1",
          question: "Complete verification.",
          options: [{ id: "done", label: "Done" }],
          presentation: "virtual_desktop",
        },
      ],
    });
    useInteractionStore.setState({
      pendingQuestion: { requestId: "req-help", entries: question },
    });
    let viewConversationCalls = 0;
    const props = baseProps({
      scrollAreaProps: { ...baseProps().scrollAreaProps, messageCount: 1 },
      documentSlot: (
        <textarea aria-label="Document" defaultValue="Unsaved edit" />
      ),
      composerSlot: <textarea aria-label="Message" defaultValue="Draft" />,
      onViewConversation: () => {
        viewConversationCalls += 1;
      },
    });
    try {
      const view = render(<ChatBody {...props} />);
      const composer = view.getByRole("textbox", { name: "Message" });
      const editor = view.getByRole("textbox", { name: "Document" });
      expect(
        view
          .getByText("The virtual desktop needs your help.")
          .closest("[hidden]"),
      ).toBeNull();
      fireEvent.click(view.getByRole("button", { name: "View conversation" }));
      expect(viewConversationCalls).toBe(1);
      view.rerender(
        <ChatBody {...props} documentPresentation="conversation" />,
      );
      expect(
        view.queryByText("The virtual desktop needs your help."),
      ).toBeNull();
      expect(view.getByTestId("transcript").closest("[hidden]")).toBeNull();
      expect(view.getByRole("textbox", { name: "Message" })).toBe(composer);
      view.rerender(<ChatBody {...props} documentPresentation="document" />);
      expect(view.getByRole("textbox", { name: "Document" })).toBe(editor);
      act(() => useInteractionStore.setState({ pendingQuestion: null }));
      expect(
        view.queryByRole("button", { name: "View conversation" }),
      ).toBeNull();
    } finally {
      act(() => useInteractionStore.setState({ pendingQuestion: null }));
    }
  });

  test("preserves the edited document and composer when only presentation changes", () => {
    const props = baseProps({
      scrollAreaProps: { ...baseProps().scrollAreaProps, messageCount: 1 },
      composerSlot: (
        <textarea aria-label="Message" defaultValue="Draft message" />
      ),
      documentSlot: (
        <textarea aria-label="Document" defaultValue="Original text" />
      ),
    });
    const view = render(<ChatBody {...props} />);
    const editor = view.getByRole("textbox", { name: "Document" });
    const composer = view.getByRole("textbox", { name: "Message" });
    fireEvent.change(editor, { target: { value: "Locally edited text" } });
    fireEvent.change(composer, { target: { value: "Unsaved message" } });
    const transcript = view.getByTestId("transcript");
    expect(transcript.closest("[hidden]")).not.toBeNull();

    view.rerender(<ChatBody {...props} documentPresentation="conversation" />);
    expect(view.queryByRole("textbox", { name: "Document" })).toBeNull();
    expect(editor.closest("[inert]")).not.toBeNull();
    expect(transcript.closest("[hidden]")).toBeNull();
    expect(view.getByRole("textbox", { name: "Message" })).toBe(composer);

    view.rerender(<ChatBody {...props} documentPresentation="document" />);
    expect(view.getByRole("textbox", { name: "Document" })).toBe(editor);
    expect(view.getByDisplayValue("Locally edited text")).toBe(editor);
    expect(view.getByRole("textbox", { name: "Message" })).toBe(composer);
    expect(view.getByDisplayValue("Unsaved message")).toBe(composer);
    expect(editor.closest("[hidden]")).toBeNull();
    expect(transcript.closest("[inert]")).not.toBeNull();
  });

  test("preserves the same focused composer and transcript across presentation switches", () => {
    const props = baseProps({
      scrollAreaProps: { ...baseProps().scrollAreaProps, messageCount: 1 },
      composerSlot: (
        <textarea aria-label="Message" defaultValue="Keep this draft" />
      ),
      queuedDrawerSlot: <div data-testid="queue">Queued message</div>,
      genericChatError: { message: "Please retry" },
    });
    const view = render(<ChatBody {...props} />);
    const input = view.getByRole("textbox");
    input.focus();
    const transcript = view.getByTestId("transcript");
    view.rerender(
      <ChatBody {...props} documentSlot={<div>Document editor</div>} />,
    );
    expect(view.getByRole("textbox")).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(view.getByTestId("transcript")).toBe(transcript);
    expect(transcript.closest("[hidden]")).not.toBeNull();
    expect(view.getByTestId("queue")).not.toBeNull();
    expect(view.getByText("Please retry")).not.toBeNull();
    view.rerender(<ChatBody {...props} />);
    expect(view.getByRole("textbox")).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(transcript.closest("[hidden]")).toBeNull();
  });
});

describe("ChatBody — empty-state centering (LUM-1566)", () => {
  test("applies safe_center and overflow-y-auto when empty state is visible", () => {
    const html = renderToStaticMarkup(<ChatBody {...withEmptyState()} />);
    expect(html).toContain("[justify-content:safe_center]");
    expect(html).toContain("overflow-y-auto");
  });

  test("does NOT apply safe_center or overflow-y-auto when empty state is hidden", () => {
    const html = renderToStaticMarkup(<ChatBody {...baseProps()} />);
    expect(html).not.toContain("[justify-content:safe_center]");
    expect(html).not.toContain("overflow-y-auto");
  });

  test("uses flex-1 in outer class for main variant", () => {
    const html = renderToStaticMarkup(
      <ChatBody {...baseProps({ variant: "main" })} />,
    );
    // The outer container class for the main variant.
    expect(html).toContain("relative flex min-h-0 flex-1 flex-col");
  });

  test("uses h-full in outer class for side-panel variant", () => {
    const html = renderToStaticMarkup(
      <ChatBody {...baseProps({ variant: "side-panel" })} />,
    );
    // The outer container class for the side-panel variant.
    expect(html).toContain("relative flex h-full min-h-0 flex-col");
  });
});

describe("ChatBody — banner overlay suppression (LUM-1566)", () => {
  test("suppresses banner overlay on empty state to prevent greeting overlap", () => {
    const html = renderToStaticMarkup(
      <ChatBody
        {...withEmptyState({
          bannerSlot: <div data-testid="banner">BANNER_CONTENT</div>,
        })}
      />,
    );
    // The banner node is passed but the overlay container should not
    // render it on the empty state — it would overlap the greeting.
    expect(html).not.toContain("BANNER_CONTENT");
  });

  test("renders banner overlay when empty state is hidden and bannerSlot is provided", () => {
    const html = renderToStaticMarkup(
      <ChatBody
        {...baseProps({
          bannerSlot: <div data-testid="banner">BANNER_CONTENT</div>,
        })}
      />,
    );
    expect(html).toContain("BANNER_CONTENT");
  });

  test("the banner takes its space in flow, and only the pill floats", () => {
    // The banner is an opaque full-width card that always occupies its own
    // height, so it belongs in the flex column: the `flex-1` scroll area
    // gives back exactly that height at every viewport size. Positioning it
    // absolutely removes it from flow and forces the space to be measured
    // and reserved in JS, which is what put this component in the error-185
    // family (LUM-2927) and cost a ResizeObserver, a state, and a prop on
    // ChatScrollArea. The pill is the opposite: it genuinely floats over the
    // transcript and reserves nothing.
    const { container } = render(
      <ChatBody
        {...baseProps({
          showScrollToLatest: true,
          bannerSlot: <div data-testid="banner">BANNER_CONTENT</div>,
        })}
      />,
    );
    try {
      const banner = container.querySelector('[data-testid="banner"]');
      const pill = container.querySelector('[data-testid="scroll-to-latest"]');
      expect(banner).not.toBeNull();
      expect(pill).not.toBeNull();

      // In flow: no positioned ancestor between the banner and the root.
      expect(banner?.closest(".absolute")).toBeNull();
      // Floating: the pill still lives in a positioned, click-through layer.
      expect(pill?.closest(".absolute")).not.toBeNull();
      expect(pill?.closest(".pointer-events-none")).not.toBeNull();
    } finally {
      cleanup();
    }
  });

  test("measures nothing: no ResizeObserver, at mount or across re-renders", () => {
    // The structural invariant. Any reintroduction of measure-to-reserve
    // here (a ref'd node, an observer, a height in state) fails this, as
    // does the subtler regression Codex caught on the first attempt: two
    // unkeyed sibling divs in one overlay, where mounting the pill lets
    // React reuse the observed banner node and leaves the observer on the
    // wrong element.
    const originalResizeObserver = globalThis.ResizeObserver;
    let observersConstructed = 0;

    globalThis.ResizeObserver = class {
      constructor() {
        observersConstructed += 1;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    };

    try {
      const { rerender } = render(
        <ChatBody
          {...baseProps({
            bannerSlot: <div data-testid="banner">BANNER_CONTENT</div>,
          })}
        />,
      );

      // Toggle the pill on and off under a live banner: the case that broke.
      for (const showScrollToLatest of [true, false, true]) {
        rerender(
          <ChatBody
            {...baseProps({
              showScrollToLatest,
              bannerSlot: <div data-testid="banner">BANNER_CONTENT</div>,
            })}
          />,
        );
      }

      expect(observersConstructed).toBe(0);
    } finally {
      globalThis.ResizeObserver = originalResizeObserver;
      cleanup();
    }
  });
});

describe("ChatBody — banner-visibility store mirroring", () => {
  // The shared store must reflect the banner actually being MOUNTED
  // (bannerSlot provided AND not on the empty state), not merely a
  // candidate slot existing. Activation surfaces hide while the store
  // reports a visible banner. Count-based register/unregister keeps
  // concurrent instances (main chat + app-editing side panel) from
  // clobbering each other.
  const bannerSlot = <div data-testid="banner">BANNER_CONTENT</div>;
  const visible = () =>
    useBannerVisibilityStore.getState().visibleBannerCount > 0;

  beforeEach(() => {
    useBannerVisibilityStore.setState({ visibleBannerCount: 0 });
  });

  afterEach(() => {
    cleanup();
  });

  test("registers while the banner overlay is mounted, unregisters on unmount", () => {
    const { unmount } = render(<ChatBody {...baseProps({ bannerSlot })} />);
    expect(visible()).toBe(true);

    unmount();
    expect(visible()).toBe(false);
  });

  test("does NOT register on the empty state even when bannerSlot is provided", () => {
    render(<ChatBody {...withEmptyState({ bannerSlot })} />);
    expect(visible()).toBe(false);
  });

  test("does NOT register without a bannerSlot (side panel passes undefined)", () => {
    render(<ChatBody {...baseProps({ variant: "side-panel" })} />);
    expect(visible()).toBe(false);
  });

  test("empty→active transition flips the store as the banner mounts/unmounts", () => {
    const { rerender } = render(
      <ChatBody {...withEmptyState({ bannerSlot })} />,
    );
    expect(visible()).toBe(false);

    rerender(<ChatBody {...baseProps({ bannerSlot })} />);
    expect(visible()).toBe(true);

    rerender(<ChatBody {...withEmptyState({ bannerSlot })} />);
    expect(visible()).toBe(false);
  });

  test("a bannerless second instance does not clobber the first's visibility", () => {
    const main = render(<ChatBody {...baseProps({ bannerSlot })} />);
    const sidePanel = render(
      <ChatBody {...baseProps({ variant: "side-panel" })} />,
    );
    expect(visible()).toBe(true);

    sidePanel.unmount();
    expect(visible()).toBe(true);

    main.unmount();
    expect(visible()).toBe(false);
  });

  test("stays visible until every banner-rendering instance unmounts", () => {
    const first = render(<ChatBody {...baseProps({ bannerSlot })} />);
    const second = render(<ChatBody {...baseProps({ bannerSlot })} />);
    expect(useBannerVisibilityStore.getState().visibleBannerCount).toBe(2);

    first.unmount();
    expect(visible()).toBe(true);

    second.unmount();
    expect(visible()).toBe(false);
  });
});

describe("ChatBody — startersSlot rendering", () => {
  test("renders startersSlot content when provided", () => {
    const html = renderToStaticMarkup(
      <ChatBody
        {...withEmptyState({
          startersSlot: <div data-testid="starters">STARTER_CHIPS</div>,
        })}
      />,
    );
    expect(html).toContain("STARTER_CHIPS");
  });

  test("omits starters when startersSlot is undefined", () => {
    const html = renderToStaticMarkup(<ChatBody {...withEmptyState()} />);
    expect(html).not.toContain("STARTER_CHIPS");
  });
});

describe("ChatBody - the empty-state scroll container never carries alignment", () => {
  // Pins the scrollability STRUCTURE, not rendered geometry (happy-dom
  // performs no layout): with `justify-end` on the `overflow-y-auto`
  // container itself, content taller than the viewport overflows past the
  // START edge, which scrolling cannot reach, so the greeting becomes
  // unreachable on short viewports while the keyboard is open. The
  // conditional alignment must live on the inner `min-h-full` wrapper.

  const outerOf = (container: HTMLElement) =>
    requireElement(container.firstElementChild, HTMLElement);

  afterEach(() => {
    keyboardOpen = false;
    cleanup();
  });

  test("keyboard open, zero starters: justify-end sits on the inner min-h-full wrapper, not the scroll container", () => {
    keyboardOpen = true;
    const { container } = render(<ChatBody {...withEmptyState()} />);

    const outer = outerOf(container);
    expect(outer.className).toContain("overflow-y-auto");
    expect(outer.className).not.toContain("justify-end");

    const inner = requireElement(outer.firstElementChild, HTMLElement);
    expect(inner.className).toContain("min-h-full");
    expect(inner.className).toContain("justify-end");
  });

  test("at rest: safe_center sits on the inner min-h-full wrapper, not the scroll container", () => {
    keyboardOpen = false;
    const { container } = render(<ChatBody {...withEmptyState()} />);

    const outer = outerOf(container);
    expect(outer.className).toContain("overflow-y-auto");
    expect(outer.className).not.toContain("[justify-content:safe_center]");

    const inner = requireElement(outer.firstElementChild, HTMLElement);
    expect(inner.className).toContain("min-h-full");
    expect(inner.className).toContain("[justify-content:safe_center]");
  });
});

describe("ChatBody — active-process overlays slot", () => {
  // The orchestrator builds the registry-driven row (subagents → acp runs →
  // workflows → background tasks) and passes it as a single node; ChatBody
  // only positions it in the top-center overlay (and gates it on the empty
  // state). Ordering across kinds is owned by the registry, not ChatBody.
  const activeProcessOverlaysSlot = (
    <div data-testid="active-process-overlays">ACTIVE_PROCESSES</div>
  );

  test("renders the slot top-center when scrolled up and slot is provided", () => {
    const html = renderToStaticMarkup(
      <ChatBody
        {...baseProps({
          showScrollToLatest: true,
          activeProcessOverlaysSlot,
        })}
      />,
    );
    expect(html).toContain("ACTIVE_PROCESSES");
  });

  test("renders the slot even when pinned (showScrollToLatest false) — always-on while running", () => {
    const html = renderToStaticMarkup(
      <ChatBody
        {...baseProps({
          showScrollToLatest: false,
          activeProcessOverlaysSlot,
        })}
      />,
    );
    expect(html).toContain("ACTIVE_PROCESSES");
  });

  test("does NOT render the slot on the empty state", () => {
    const html = renderToStaticMarkup(
      <ChatBody
        {...withEmptyState({
          showScrollToLatest: true,
          activeProcessOverlaysSlot,
        })}
      />,
    );
    expect(html).not.toContain("ACTIVE_PROCESSES");
  });

  test("does NOT render the overlay row when the slot is undefined", () => {
    const html = renderToStaticMarkup(
      <ChatBody {...baseProps({ showScrollToLatest: true })} />,
    );
    expect(html).not.toContain("ACTIVE_PROCESSES");
  });

  test("Go-to-Newest bottom overlay still renders alongside the slot (no regression)", () => {
    const html = renderToStaticMarkup(
      <ChatBody
        {...baseProps({
          showScrollToLatest: true,
          activeProcessOverlaysSlot,
        })}
      />,
    );
    expect(html).toContain("SCROLL_TO_LATEST");
    expect(html).toContain("ACTIVE_PROCESSES");
  });
});

describe("ChatBody — composer always renders", () => {
  // Channel-origin (Slack/Email/etc.) conversations render the standard
  // composer, with no read-only banner replacing it.
  test("renders the composer and no read-only banner", () => {
    const html = renderToStaticMarkup(<ChatBody {...baseProps()} />);

    expect(html).toContain("COMPOSER");
    expect(html).not.toContain("Read-only conversation");
  });
});

describe("ChatBody — channel footer slot", () => {
  test("renders channelFooterSlot immediately above the composer", () => {
    const html = renderToStaticMarkup(
      <ChatBody
        {...baseProps({
          channelFooterSlot: (
            <div data-testid="channel-footer">CHANNEL_FOOTER</div>
          ),
        })}
      />,
    );

    expect(html).toContain("CHANNEL_FOOTER");
    expect(html.indexOf("CHANNEL_FOOTER")).toBeLessThan(
      html.indexOf("COMPOSER"),
    );
  });
});

describe("ChatBody — generic chat error Notice (dismiss UX)", () => {
  // The Notice is rendered as an inline error banner above the composer.
  // The banner carries its own action ("Go to Doctor") plus the notice's
  // dismiss control, so the user has a real way to close the banner.

  test("renders the dismiss control when genericChatError + onDismissChatError are both provided", () => {
    const html = renderToStaticMarkup(
      <ChatBody
        {...baseProps({
          genericChatError: {
            message: "Model doesn't support image input.",
            actions: <a href="/account/doctor">Go to Doctor</a>,
          },
          onDismissChatError: () => {},
        })}
      />,
    );

    expect(html).toContain("Go to Doctor");
    expect(html).toContain('data-testid="notice-dismiss"');
  });

  test("renders warning-tone generic notices as status banners", () => {
    const html = renderToStaticMarkup(
      <ChatBody
        {...baseProps({
          genericChatError: {
            message: "Memory is temporarily unavailable.",
            tone: "warning",
          },
          onDismissChatError: () => {},
        })}
      />,
    );

    expect(html).toContain("Memory is temporarily unavailable.");
    expect(html).toContain('data-tone="warning"');
  });

  test("does NOT render the dismiss control when onDismissChatError is omitted", () => {
    // Defensive: don't silently show a dismiss control that does nothing.
    const html = renderToStaticMarkup(
      <ChatBody
        {...baseProps({
          genericChatError: { message: "Something went wrong." },
        })}
      />,
    );

    expect(html).not.toContain("notice-dismiss");
  });

  test("does not render the error banner at all when genericChatError is null", () => {
    const html = renderToStaticMarkup(
      <ChatBody {...baseProps({ genericChatError: null })} />,
    );

    expect(html).not.toContain('data-testid="notice"');
  });
});
