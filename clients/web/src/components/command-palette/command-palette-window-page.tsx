import { useCallback, useMemo } from "react";

import {
  CommandPalette,
  type CommandPaletteItemData,
} from "@/components/command-palette/command-palette";
import { useAssistantBootResolution } from "@/assistant/queries";
import { useCommandPaletteSections } from "@/domains/chat/hooks/use-command-palette-sections";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useConversationListQuery } from "@/hooks/conversation-queries";
import { useGatedSelectedAssistantId } from "@/assistant/selection";
import {
  dismissCommandPaletteWindow,
  selectCommandPaletteCommand,
} from "@/runtime/command-palette-window";
import type { CadetCommand } from "@/runtime/is-electron";
import {
} from "@/stores/auth-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

const noop = (): void => undefined;
const noopNavigate = (_to: string | number): void => undefined;

const commandForItem = (item: CommandPaletteItemData): CadetCommand | null => {
  switch (item.id) {
    case "action-new-conversation":
      return { kind: "newConversation" };
    case "action-current-conversation":
      return { kind: "currentConversation" };
    case "action-settings":
      return { kind: "openSettings" };
    case "action-library":
      return { kind: "openLibrary" };
    case "action-intelligence":
      return { kind: "openIdentity" };
    default:
      if (item.id.startsWith("conv-")) {
        return {
          kind: "openConversation",
          conversationId: item.id.slice("conv-".length),
        };
      }
      if (item.id.startsWith("search-conv-")) {
        return {
          kind: "openConversation",
          conversationId: item.id.slice("search-conv-".length),
        };
      }
      if (
        item.id.startsWith("search-schedule-") ||
        item.id.startsWith("search-contact-")
      ) {
        return { kind: "openIdentity" };
      }
      return null;
  }
};

export function CommandPaletteWindowPage() {
  // This standalone route bypasses RootLayout; bootstrap theme + feature flags
  // so CSS custom properties resolve to the user's stored preference, and
  // mount the boot resolution (the same shared query cache + projection
  // effects the root mounts) so the palette resolves the assistant itself.
  useAppTheme();
  useAssistantBootResolution();

  const assistants = useResolvedAssistantsStore.use.assistants();
  const activeAssistantId = useResolvedAssistantsStore.use.activeAssistantId();
  // The same gated read the resolution uses; when no selection is honored,
  // track the resolved active id, so the palette never binds to a
  // selection the resolution ignored.
  const gatedSelectedAssistantId = useGatedSelectedAssistantId();
  const selectedAssistant = useMemo(() => {
    const selectedId = gatedSelectedAssistantId ?? activeAssistantId;
    if (!selectedId) {
      return null;
    }
    const entry = assistants.find((a) => a.id === selectedId);
    return entry ? { id: entry.id, name: entry.name } : null;
  }, [gatedSelectedAssistantId, activeAssistantId, assistants]);
  const assistantId = selectedAssistant?.id ?? null;
  const { conversations } = useConversationListQuery(assistantId, true);

  const handleItemSelect = useCallback((item: CommandPaletteItemData) => {
    const command = commandForItem(item);
    if (command) {
      void selectCommandPaletteCommand(command);
    }
  }, []);

  const {
    commandPalette,
    mergedSections,
    handleItemSelect: selectItem,
  } = useCommandPaletteSections({
    assistantId,
    assistantName: selectedAssistant?.name,
    conversations,
    activeConversationId: undefined,
    startNewConversation: noop,
    switchConversation: noop,
    navigate: noopNavigate,
    navigateToSettings: noop,
    isOpen: true,
    onClose: () => {
      void dismissCommandPaletteWindow();
    },
    onItemSelect: handleItemSelect,
  });

  return (
    <div className="h-screen w-screen bg-transparent">
      <CommandPalette
        isOpen
        surface="window"
        onClose={commandPalette.close}
        query={commandPalette.query}
        onQueryChange={commandPalette.setQuery}
        highlightTokens={commandPalette.searchTokens}
        selectedIndex={commandPalette.selectedIndex}
        sections={mergedSections}
        isSearching={commandPalette.isSearching}
        onItemSelect={selectItem}
        onKeyDown={commandPalette.handleKeyDown}
      />
    </div>
  );
}
