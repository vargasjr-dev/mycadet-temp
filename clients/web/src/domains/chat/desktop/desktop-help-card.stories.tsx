import { mock } from "bun:test";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useLayoutEffect } from "react";
import { createPortal } from "react-dom";

import type { AssistantResolutionState } from "@/assistant/types";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { TranscriptColumn } from "@/domains/chat/transcript/transcript-column";

import { DesktopHelpCard } from "./desktop-help-card";
let resolutionState: AssistantResolutionState = { kind: "loading" };
function setResolutionState(next: AssistantResolutionState) {
  resolutionState = next;
}
mock.module("@/assistant/queries", () => ({
  useAssistantResolution: () => ({ state: resolutionState }),
  useAssistantBootResolution: () => ({ state: resolutionState }),
}));
import { useDesktopPreviewStore } from "./desktop-preview-store";

function PreviewFixture() {
  const preview = useDesktopPreviewStore.use.inlinePreview();
  const session = useDesktopPreviewStore.use.session();
  useLayoutEffect(() => {
    const initialSession = useDesktopPreviewStore.getState().session;
    const assistantId = useResolvedAssistantsStore.getState().activeAssistantId;
    const previousLifecycleState = resolutionState;
    useResolvedAssistantsStore.setState({
      activeAssistantId: "assistant-example",
    });
    setResolutionState({ kind: "active" });
    return () => {
      useDesktopPreviewStore.setState({ session: initialSession });
      useResolvedAssistantsStore.setState({ activeAssistantId: assistantId });
      setResolutionState(previousLifecycleState);
    };
  }, []);
  return (
    preview &&
    session?.assistantId === preview.assistantId &&
    createPortal(
      <div className="flex h-full flex-col bg-white text-neutral-800">
        <div className="bg-neutral-100 px-3 py-2 text-xs">example.com</div>
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-xs">
          <span>Verification required</span>
          <div className="w-36 rounded border border-neutral-300 p-3 text-center">
            Slide to verify
          </div>
        </div>
      </div>,
      preview.container,
    )
  );
}

const meta = {
  title: "Chat/DesktopHelpCard",
  component: DesktopHelpCard,
  parameters: { layout: "padded" },
  args: {
    entry: {
      id: "q1",
      question: "Please complete the browser verification so I can continue.",
      presentation: "virtual_desktop",
      options: [],
    },
    isSubmitting: false,
    onSubmit: () => {},
  },
  decorators: [
    (Story) => (
      <TranscriptColumn>
        <div className="space-y-4 py-4">
          <p>Find a handmade ceramic mug.</p>
          <p>I found a shop, but it needs human verification.</p>
          <Story />
          <PreviewFixture />
        </div>
      </TranscriptColumn>
    ),
  ],
} satisfies Meta<typeof DesktopHelpCard>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Pending: Story = {};
export const LongInstructions: Story = {
  args: {
    entry: {
      ...meta.args.entry,
      question:
        "Please complete the verification in the virtual desktop. The page is showing a slider that needs a person to move it. Choose Step In to open the desktop, follow the instructions shown by the website, then close the desktop and choose Done so I can inspect the page and continue. If you cannot finish the verification, choose Skip.",
    },
  },
};
