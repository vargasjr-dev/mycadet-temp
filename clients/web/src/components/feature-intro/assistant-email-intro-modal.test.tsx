import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";

import { avatarQueryKey } from "@/hooks/use-assistant-avatar";

import {
  AssistantEmailIntroModal,
  type AssistantEmailIntroModalProps,
} from "./assistant-email-intro-modal";

const ASSISTANT_ID = "asst-test";

function renderModal(overrides: Partial<AssistantEmailIntroModalProps> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  for (const supportsManifest of [true, false]) {
    client.setQueryData([...avatarQueryKey(ASSISTANT_ID), supportsManifest], {
      components: null,
      traits: null,
      customImageUrl: null,
    });
  }
  const props: AssistantEmailIntroModalProps = {
    open: true,
    onOpenChange: () => {},
    assistantId: ASSISTANT_ID,
    assistantName: "Mel",
    rootDomain: "cadet.me",
    onSetUp: () => {},
    ...overrides,
  };
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AssistantEmailIntroModal {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
});

describe("AssistantEmailIntroModal", () => {
  test("the intro gets the perks and the way into setup", () => {
    let setUp = 0;
    renderModal({ onSetUp: () => setUp++ });
    expect(
      screen.getByText("Every message kept here, inbox and sent"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Set up email" }));
    expect(setUp).toBe(1);
  });

  test("the close glyph reports the dismissal", () => {
    const changes: boolean[] = [];
    renderModal({ onOpenChange: (open) => changes.push(open) });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(changes).toEqual([false]);
  });
});
