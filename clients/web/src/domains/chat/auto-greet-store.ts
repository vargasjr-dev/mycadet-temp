import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";

/**
 * The post-hatch auto-greet one-shot: set when any hatch path completes,
 * cleared on chat-surface exit conditions (first message arrived, safety
 * timer, conversation switch) or on logout.
 *
 * Lives in the chat domain (it is hatch UX, not session state) so producers
 * can fire from inside the ChatPage tree (e.g. the version-selection screen,
 * the pre-chat sessionStorage detector) and the gate updates without needing
 * a mount/remount.
 */
interface AutoGreetState {
  expectingFirstMessage: boolean;
}

interface AutoGreetActions {
  markExpectingFirstMessage: () => void;
  clearExpectingFirstMessage: () => void;
}

const useAutoGreetStoreBase = create<AutoGreetState & AutoGreetActions>(() => ({
  expectingFirstMessage: false,
  markExpectingFirstMessage: () => {
    if (useAutoGreetStoreBase.getState().expectingFirstMessage) {
      return;
    }
    useAutoGreetStoreBase.setState({ expectingFirstMessage: true });
  },
  clearExpectingFirstMessage: () => {
    if (!useAutoGreetStoreBase.getState().expectingFirstMessage) {
      return;
    }
    useAutoGreetStoreBase.setState({ expectingFirstMessage: false });
  },
}));

export const useAutoGreetStore = createSelectors(useAutoGreetStoreBase);
