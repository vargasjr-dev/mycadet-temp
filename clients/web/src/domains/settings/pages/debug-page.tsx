import { useCallback } from "react";

import { useNavigate, useSearchParams } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { AllConversationsView } from "@/domains/settings/components/all-conversations-view";
import { AssistantTerminalPanel } from "@/domains/settings/components/panels/assistant-terminal-panel";
import { DatabaseDebugPanel } from "@/domains/settings/components/panels/database-debug-panel";
import { ToneLabPanel } from "@/domains/settings/components/tone-lab/tone-lab-panel";
import { resolveDebugTabParam } from "@/domains/settings/pages/debug-page.helpers";
import { useTranslation } from "@/i18n";
import { navigateToConversation } from "@/utils/conversation-navigation";
import { Tabs } from "@mycadet/design-library/components/tabs";

const ALL_TABS = [
  {
    id: "terminal",
    labelKey: "debugPage.tabs.terminal",
    defaultLabel: "Terminal",
  },
  {
    id: "database",
    labelKey: "debugPage.tabs.database",
    defaultLabel: "Database",
  },
  {
    id: "conversations",
    labelKey: "debugPage.tabs.conversations",
    defaultLabel: "Conversations",
  },
  { id: "tones", labelKey: "debugPage.tabs.tones", defaultLabel: "Tone lab" },
] as const;

type DebugTabId = (typeof ALL_TABS)[number]["id"];

const DEFAULT_TAB: DebugTabId = "terminal";

export function DebugPage() {
  const { t } = useTranslation("settings");
  const [searchParams, setSearchParams] = useSearchParams();
  const assistantId = useActiveAssistantId();
  const navigate = useNavigate();

  const handleOpenConversation = useCallback(
    (conversationId: string) => {
      navigateToConversation(navigate, conversationId);
    },
    [navigate],
  );
  const { tabId, conversationsFilter } = resolveDebugTabParam(
    searchParams.get("tab"),
  );

  // Every tab renders now; an unknown deep-link falls back to General.
  const activeTab: DebugTabId = (ALL_TABS as readonly { id: string }[]).some(
    (tab) => tab.id === tabId,
  )
    ? (tabId as DebugTabId)
    : DEFAULT_TAB;

  const handleTabChange = (value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value === DEFAULT_TAB) {
      next.delete("tab");
    } else {
      next.set("tab", value);
    }
    setSearchParams(next, { replace: true });
  };

  return (
    // The Terminal and Doctor panels rely on a `flex min-h-0 flex-1 flex-col`
    // ancestor chain to size their console/messages area; the settings `<main>`
    // is a bounded-height flex column, so the page root and Tabs.Root extend
    // that chain. General keeps block flow (`pt-4`) and scrolls.
    <div className="flex min-h-0 flex-1 flex-col">
      <Tabs.Root
        value={activeTab}
        onValueChange={handleTabChange}
        className="flex min-h-0 flex-1 flex-col"
      >
        <Tabs.List>
          {ALL_TABS.map((tab) => (
            <Tabs.Trigger key={tab.id} value={tab.id}>
              {t(tab.labelKey, tab.defaultLabel)}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        <Tabs.Panel
          value="terminal"
          className="flex min-h-0 flex-1 flex-col pt-4"
        >
          <AssistantTerminalPanel />
        </Tabs.Panel>
        <Tabs.Panel value="database" className="pt-4">
          <DatabaseDebugPanel />
        </Tabs.Panel>
        <Tabs.Panel
          value="conversations"
          className="flex min-h-0 flex-1 flex-col pt-4"
        >
          {/* `initialFilter` only seeds state on mount, and the panel stays
              mounted when ?tab flips archive→conversations, so key on the
              intended filter to re-seed it. */}
          <AllConversationsView
            key={conversationsFilter}
            assistantId={assistantId}
            initialFilter={conversationsFilter}
            onOpenConversation={handleOpenConversation}
          />
        </Tabs.Panel>
        <Tabs.Panel value="tones" className="pt-4">
          <ToneLabPanel />
        </Tabs.Panel>
      </Tabs.Root>
    </div>
  );
}
