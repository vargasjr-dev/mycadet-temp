/**
 * Pins that `applyPersonality` persists the raw dial positions as the
 * `data/personality-sliders.json` workspace sidecar — the About Assistant
 * personality page and the overview's signature read it, so skipping the save
 * left both empty after onboarding (the prose rewrite alone loses the
 * numbers). Kept separate from `apply-personality.test.ts` so the pure
 * message-builder tests stay free of module mocks.
 *
 * Also pins that the rewrite send goes out hidden (see
 * `lib/side-conversation-message.ts`) and that the throwaway thread is minted
 * `background`, which is what keeps it out of the conversation list.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const createConversationMock = mock(
  async (_assistantId: string, body: { conversationType?: string }) => ({
    ok: true,
    status: 200,
    data: { id: "conv-1", ...body },
  }),
);
const postMessageMock = mock(
  async (_assistantId: string, body: { hidden?: boolean }) => ({
    ok: true,
    status: 200,
    data: body,
  }),
);
const listMessagesMock = mock(async () => ({
  ok: true,
  status: 200,
  data: {
    processing: false,
    messages: [
      {
        role: "assistant",
        contentBlocks: [{ type: "text", text: "All rewritten!" }],
      },
    ],
  },
}));
const archiveMock = mock(async () => ({ ok: true, status: 200, data: null }));
mock.module("@app/gateway/daemon", () => ({
  createAssistantConversation: createConversationMock,
  postAssistantMessage: postMessageMock,
  listAssistantMessages: listMessagesMock,
  archiveAssistantConversation: archiveMock,
}));

const saveSlidersMock = mock(async () => true);
mock.module("@web/assistant/personality-sliders", () => ({
  completeSliderValues: (values: Record<string, number>) => ({
    "companion-coworker": 50,
    ...values,
  }),
  savePersonalitySliders: saveSlidersMock,
}));
mock.module("@mycadet/design-library/utils/capture-error", () => ({
  captureError: () => {},
}));

const { applyPersonality } = await import("./apply-personality");

beforeEach(() => {
  createConversationMock.mockClear();
  postMessageMock.mockClear();
  archiveMock.mockClear();
  saveSlidersMock.mockClear();
});

describe("applyPersonality rewrite prompt", () => {
  test("mints a background thread and posts the rewrite prompt as a hidden machine signal", async () => {
    // The thread's only renderable content is the assistant's first-person
    // self-description (the prompt posts hidden), so the `background` mint is
    // what keeps it out of the user's view. See
    // `lib/side-conversation-message.ts` for why the prompt posts hidden.
    await applyPersonality({
      awaitAssistantId: async () => "ast-1",
      values: {},
    });

    expect(createConversationMock.mock.calls[0]?.[1]).toMatchObject({
      conversationType: "background",
      title: "Updating personality",
    });
    expect(postMessageMock.mock.calls[0]?.[1].hidden).toBe(true);
  });
});

describe("applyPersonality slider persistence", () => {
  test("saves the completed slider values once the rewrite message posts", async () => {
    await applyPersonality({
      awaitAssistantId: async () => "ast-1",
      values: { "playful-serious": 80 },
    });

    expect(saveSlidersMock).toHaveBeenCalledTimes(1);
    expect(saveSlidersMock.mock.calls[0]).toEqual([
      "ast-1",
      { "companion-coworker": 50, "playful-serious": 80 },
    ] as never);
  });

  test("skips the save when the rewrite message fails to post", async () => {
    postMessageMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      error: { detail: "nope" },
    });

    await applyPersonality({
      awaitAssistantId: async () => "ast-1",
      values: { "playful-serious": 80 },
    });

    expect(saveSlidersMock).not.toHaveBeenCalled();
  });
});
