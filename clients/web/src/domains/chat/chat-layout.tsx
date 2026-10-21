import {
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useLocation, useNavigate, useNavigationType } from "react-router";

import { assistantStateCanServeChat } from "@/assistant/lifecycle";
import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { MOBILE_MEDIA_QUERY, useIsMobile } from "@/hooks/use-is-mobile";
import {
  getLocalBool,
  getLocalNumber,
  setLocalBool,
  setLocalNumber,
} from "@/utils/local-settings";
import {
  conversationIdForPath,
  isAboutAssistantPath,
  isConversationPath,
  routes,
} from "@/utils/routes";

import { useChatLayoutSlotsStore } from "@/components/layout/chat-layout-slots-store";
import { useElectronDockSync } from "@/domains/chat/hooks/use-electron-dock-sync";
import { useNativeRecentChatsSync } from "@/domains/chat/hooks/use-native-recent-chats-sync";
import { useNativeWidgetSnapshotSync } from "@/domains/chat/hooks/use-native-widget-snapshot-sync";
import { useOpenAppFromChat } from "@/domains/chat/hooks/use-open-app-from-chat";
import { DRAWER_SURFACE_BACKGROUND } from "@/domains/chat/utils/drawer-surface";
import {
  EDGE_SWIPE_EASING,
  EDGE_SWIPE_SLIDE_MS,
} from "@/hooks/edge-swipe-motion";
import { useSoftKeyboardOpen } from "@/hooks/use-keyboard-open";
import { useSwipeDownDismissKeyboard } from "@/hooks/use-swipe-down-dismiss-keyboard";
import { useCommandPaletteStore } from "@/stores/command-palette-store";
import { useMobileDrawerStore } from "@/stores/mobile-drawer-store";

import { useActiveConversation } from "@/domains/chat/hooks/use-active-conversation";
import { useAttentionTracking } from "@/domains/chat/hooks/use-attention-tracking";
import { isTranscriptOnScreen } from "@/domains/chat/utils/transcript-visibility";
import { useChatLayoutDrawer } from "@/domains/chat/hooks/use-chat-layout-drawer";
import { useChatLayoutDrawerGestures } from "@/domains/chat/hooks/use-chat-layout-drawer-gestures";
import { useChatLayoutShortcuts } from "@/domains/chat/hooks/use-chat-layout-shortcuts";
import { useConversationActions } from "@/domains/chat/hooks/use-conversation-actions";
import { useConversationGroupActions } from "@/domains/chat/hooks/use-conversation-group-actions";
import { useConversationListDeepLink } from "@/domains/chat/hooks/use-conversation-list-deep-link";
import { useMaterializedDraftReconcile } from "@/domains/chat/hooks/use-materialized-draft-reconcile";
import { useGroupNameRequestStore } from "@/domains/chat/group-name-request-store";
import {
  keptAppId,
  navigateToConversation,
  navigateToNewConversation,
} from "@/utils/conversation-navigation";
import { haptic } from "@/utils/haptics";

import {
  useConversationGroupsQuery,
  useConversationListQuery,
} from "@/hooks/conversation-queries";
import { openCommandPaletteWindow } from "@/runtime/command-palette-window";
import { isElectron } from "@/runtime/is-electron";
import { useIsNativePlatform } from "@/runtime/native-auth";
import { isPopoutWindow, openPopoutWindow } from "@/runtime/popout-window";
import { useCadetCommands } from "@/runtime/cadet-commands";
import { useConversationStore } from "@/stores/conversation-store";
import { useOnboardingFocusStore } from "@/stores/onboarding-focus-store";
import { useViewerStore } from "@/stores/viewer-store";
import type { Conversation } from "@/types/conversation-types";
import { requestComposerFocus } from "./composer-focus";

import { LazyBoundary } from "@/components/lazy-boundary";
import { RuntimeUpgradeBanner } from "@/components/runtime-upgrade-banner";
import { StatusBanner } from "@/components/status-banner";
import { AssistantSleepStage } from "@/domains/chat/components/assistant-sleep-stage";
import { useAssistantSleepStageStore } from "@/stores/assistant-sleep-stage-store";
import { AssistantSideMenu } from "@/domains/chat/components/assistant-side-menu";
import { PreferencesMenu } from "@/domains/chat/components/preferences-menu";
import { useCommandPaletteOrchestrator } from "@/domains/chat/hooks/use-command-palette-orchestrator";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { ResearchResultsOverlay } from "@/domains/chat/onboarding-research/research-results-overlay";
import { AssistantEmailIntro } from "@/components/feature-intro/assistant-email-intro";
import { OnboardingAvatarApplier } from "@/components/onboarding-avatar-applier";
import { VoiceSessionPillHost } from "@/domains/chat/components/voice-session-pill-host";
import { AssistantDesktopPreview } from "@/domains/chat/desktop/assistant-desktop-preview";
import { AssistantDesktopAffordance } from "@/domains/chat/desktop/assistant-desktop-affordance";
import { useLiveVoiceSessionController } from "@/domains/chat/voice/live-voice/use-live-voice-session-controller";
import { useSeedLiveVoiceSnapshot } from "@/domains/chat/voice/live-voice/use-seed-live-voice-snapshot";
import { VoiceRoom } from "@/domains/chat/voice/voice-room/voice-room";
import { useIsVoiceRoomVisible } from "@/domains/chat/voice/voice-room/use-is-voice-room-visible";
import { ChatConversationHeader } from "./chat-conversation-header";
import { ChatLayoutFrame } from "./chat-layout-frame";
import { ChatLayoutHeader } from "./chat-layout-header";
import { useDocumentHeaderVisible } from "./hooks/use-document-header-visible";
import {
  ArchiveAllConfirmDialog,
  useArchiveAllConfirmation,
} from "./components/archive-all-confirm-dialog";
import {
  DeleteConversationConfirmDialog,
  useDeleteConversationConfirmation,
} from "./components/delete-conversation-confirm-dialog";
import { GroupNameDialogFromStore } from "./group-name-dialog-from-store";
import { RenameDialogFromStore } from "./rename-dialog-from-store";
import { useTranslation } from "@/i18n";

const CommandPalette = lazy(() =>
  import("@/components/command-palette/command-palette").then((m) => ({
    default: m.CommandPalette,
  })),
);

const SIDEBAR_COLLAPSED_STORAGE_KEY = "cadet:sidebar:collapsed";
const SIDEBAR_WIDTH_STORAGE_KEY = "cadet:sidebar:width";
const DEFAULT_SIDEBAR_WIDTH = 230;
const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 400;

function readPersistedCollapsed(): boolean {
  return getLocalBool(SIDEBAR_COLLAPSED_STORAGE_KEY, false);
}

function readPersistedWidth(): number {
  const raw = getLocalNumber(SIDEBAR_WIDTH_STORAGE_KEY, DEFAULT_SIDEBAR_WIDTH);
  if (raw > 0) {
    return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, raw));
  }
  return DEFAULT_SIDEBAR_WIDTH;
}

type SideMenuVariant = "rail" | "overlay";

interface SideMenuRenderArgs {
  collapsed: boolean;
  variant: SideMenuVariant;
  width?: number;
  onWidthChange?: (width: number) => void;
  onClose?: () => void;
}

export function ChatLayout({
  topBarAccessory,
  topBarPill,
}: {
  topBarAccessory?: ReactNode;

  topBarPill?: ReactNode;
} = {}) {
  const { t } = useTranslation("chat");
  const navigate = useNavigate();
  const location = useLocation();
  const navigationType = useNavigationType();

  const [isPopout] = useState(() => isPopoutWindow(location.search));

  const isFocused = useOnboardingFocusStore.use.focused();
  const sidebarCollapseRequested =
    useOnboardingFocusStore.use.sidebarCollapseRequested();
  const consumeSidebarCollapse =
    useOnboardingFocusStore.use.consumeSidebarCollapse();

  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const assistantStateKind = useAssistantLifecycleStore(
    (s) => s.assistantState.kind,
  );

  const isAssistantActive = assistantStateCanServeChat(assistantStateKind);

  useLiveVoiceSessionController();

  useSeedLiveVoiceSnapshot();

  const {
    conversations,
    isLoading: isLoadingConversations,
    isPending: isConversationListPending,
    isError: conversationsFailed,
    refetch: retryConversations,
  } = useConversationListQuery(assistantId, isAssistantActive);
  const {
    conversationGroups,
    isPending: isGroupsPending,
    isError: groupsFailed,
  } = useConversationGroupsQuery(assistantId, isAssistantActive);

  useMaterializedDraftReconcile(conversations);

  const isMobile = useIsMobile();
  const viewerMainView = useViewerStore.use.mainView();
  const viewerAppMinimized = useViewerStore.use.isAppMinimized();
  const transcriptOnScreen = isTranscriptOnScreen({
    pathname: location.pathname,
    mainView: viewerMainView,
    isAppMinimized: viewerAppMinimized,
    isNarrow: isMobile,
  });

  useAttentionTracking({
    assistantId,
    assistantStateKind,
    isTranscriptOnScreen: transcriptOnScreen,
  });

  const { createGroup, renameGroup, handleDeleteGroup } =
    useConversationGroupActions({
      assistantId,
      conversationGroups,
    });

  useElectronDockSync(assistantId, conversations, isAssistantActive);

  useNativeRecentChatsSync(
    conversations,
    !isConversationListPending && !conversationsFailed,
  );

  useNativeWidgetSnapshotSync(
    assistantId,
    conversations,
    conversationGroups,
    isAssistantActive,
    !isConversationListPending &&
      !conversationsFailed &&
      !isGroupsPending &&
      !groupsFailed,
  );

  const topBarCenterSlot = useChatLayoutSlotsStore.use.topBarCenter();
  const headerSupplements = useChatLayoutSlotsStore.use.headerSupplements();
  const topBarRightSlot = useChatLayoutSlotsStore.use.topBarRightSlot();
  const mobileTopBar = useChatLayoutSlotsStore.use.mobileTopBar();
  const isNative = useIsNativePlatform();
  const electron = isElectron();

  const assistantName = useAssistantIdentityStore.use.name();
  const assistantVersion = useAssistantIdentityStore.use.version();

  const [historyIndex, setHistoryIndex] = useState(0);
  const [maxHistoryIndex, setMaxHistoryIndex] = useState(0);
  const [prevLocation, setPrevLocation] = useState(location);

  if (prevLocation !== location) {
    const idx = (window.history.state?.idx as number) ?? 0;
    setPrevLocation(location);
    setHistoryIndex(idx);

    setMaxHistoryIndex(
      navigationType === "PUSH" ? idx : (prev) => Math.max(prev, idx),
    );
  }

  const canGoBack = historyIndex > 0;
  const canGoForward = historyIndex < maxHistoryIndex;

  const handleOpenIdentity = useCallback(() => {
    navigate(routes.identity);
  }, [navigate]);

  const handleGoBack = useCallback(() => {
    navigate(-1);
  }, [navigate]);

  const handleGoForward = useCallback(() => {
    navigate(1);
  }, [navigate]);

  const isIdentityActive = isAboutAssistantPath(location.pathname);

  const [collapsed, setCollapsed] = useState<boolean>(readPersistedCollapsed);
  const [sidebarWidth, setSidebarWidth] = useState<number>(readPersistedWidth);

  const effectiveCollapsed = collapsed;

  useEffect(() => {
    setLocalBool(SIDEBAR_COLLAPSED_STORAGE_KEY, collapsed);
  }, [collapsed]);

  const handleSidebarWidthChange = useCallback((width: number) => {
    setSidebarWidth(width);
    setLocalNumber(SIDEBAR_WIDTH_STORAGE_KEY, Math.round(width));
  }, []);

  const [drawerOpen, setDrawerOpen] = useState<boolean>(false);

  const openDrawerForDeepLink = useCallback(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    setDrawerOpen(true);
  }, []);

  const expandSidebarForDeepLink = useCallback(() => setCollapsed(false), []);

  useEffect(() => {
    if (!isMobile) {
      setDrawerOpen(false);
    }
  }, [isMobile]);

  useEffect(() => {
    setDrawerOpen(false);
  }, [location.key]);

  useConversationListDeepLink({
    isMobile,
    openDrawer: openDrawerForDeepLink,
    expandSidebar: expandSidebarForDeepLink,
  });

  useEffect(() => {
    if (!sidebarCollapseRequested) {
      return;
    }

    setCollapsed(true);
    setDrawerOpen(false);
    consumeSidebarCollapse();
  }, [sidebarCollapseRequested, consumeSidebarCollapse]);

  const voiceRoomVisible = useIsVoiceRoomVisible();

  const sleepStageVisible = useAssistantSleepStageStore.use.visible();

  const drawerVisible = isMobile && drawerOpen;

  const toggleSidebar = useCallback(() => {
    haptic.light();
    if (window.matchMedia(MOBILE_MEDIA_QUERY).matches) {
      setDrawerOpen((value) => {
        if (!value) {
          (document.activeElement as HTMLElement | null)?.blur();
        }
        return !value;
      });
    } else {
      setCollapsed((value) => !value);
    }
  }, []);

  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  const startNewConversation = useCallback(
    (opts?: { silent?: boolean }) => {
      navigateToNewConversation(navigate, opts);
    },
    [navigate],
  );

  useChatLayoutShortcuts({
    toggleSidebar,
    onGoBack: handleGoBack,
    onGoForward: handleGoForward,
    onNewConversation: startNewConversation,
  });

  const drawerRef = useChatLayoutDrawer({
    visible: drawerVisible,
    onClose: closeDrawer,
  });

  const drawerGestures = useChatLayoutDrawerGestures({
    panelRef: drawerRef,
    isMobile,
    open: drawerOpen,
    onOpen: () => {
      (document.activeElement as HTMLElement | null)?.blur();
      setDrawerOpen(true);
    },
    onClose: closeDrawer,
  });

  const drawerPresented = isMobile && drawerGestures.present;
  const setDrawerPresented = useMobileDrawerStore.use.setPresented();
  useLayoutEffect(() => {
    setDrawerPresented(drawerPresented);
    return () => {
      setDrawerPresented(false);
    };
  }, [drawerPresented, setDrawerPresented]);

  useSwipeDownDismissKeyboard({ enabled: useSoftKeyboardOpen() });

  const activeConversationId = useConversationStore.use.activeConversationId();
  const processingConversationIds =
    useConversationStore.use.processingConversationIds();
  const attentionConversationIds =
    useConversationStore.use.attentionConversationIds();

  const handleSelectConversation = useCallback(
    (key: string) => {
      navigateToConversation(navigate, key);
      setDrawerOpen(false);
    },
    [navigate],
  );

  const prePinGroupIdsRef = useRef<Map<string, string | undefined>>(new Map());

  const {
    handleArchiveConversation,
    handleUnarchiveConversation,
    handleDeleteConversation,
    handleMarkConversationUnread,
    handleMarkConversationRead,
    handleTogglePinConversation,
    handleMoveToGroup,
    handleRemoveFromGroup,
    handleRenameConversation,
    handleMarkAllReadInGroup,
    handleArchiveAllInGroup,
  } = useConversationActions({
    assistantId: assistantId,
    activeConversationId,
    conversations,
    switchConversation: handleSelectConversation,
    startNewConversation,
    prePinGroupIdsRef,
  });

  const {
    pending: pendingArchiveAll,
    requestArchiveAll,
    confirmArchiveAll,
    cancelArchiveAll,
  } = useArchiveAllConfirmation({
    assistantId,
    archiveAllInGroup: handleArchiveAllInGroup,
  });

  const {
    pending: pendingDeleteConversation,
    requestDelete,
    confirmDelete,
    cancelDelete,
  } = useDeleteConversationConfirmation({
    assistantId,
    deleteConversation: handleDeleteConversation,
  });

  const handleRequestCreateGroup = useCallback(
    (conversation: Conversation) =>
      useGroupNameRequestStore.getState().requestCreateGroup(conversation),
    [],
  );
  const handleRequestCreateEmptyGroup = useCallback(
    () => useGroupNameRequestStore.getState().requestCreateGroup(),
    [],
  );
  const handleRequestRenameGroup = useCallback(
    (groupId: string) => {
      const group = conversationGroups.find((g) => g.id === groupId);
      useGroupNameRequestStore
        .getState()
        .requestRenameGroup(groupId, group?.name ?? "", group?.icon ?? null);
    },
    [conversationGroups],
  );

  useEffect(() => {
    useGroupNameRequestStore.getState().clearGroupNameRequest();
  }, [assistantId]);

  const activeConversation =
    useActiveConversation(
      assistantId,
      activeConversationId,
      isAssistantActive,
    ) ?? null;

  const topBarCenter =
    topBarCenterSlot ??
    (headerSupplements ? (
      <ChatConversationHeader
        assistantId={assistantId}
        activeConversation={activeConversation}
        headerSupplements={headerSupplements}
        onArchive={handleArchiveConversation}
        onUnarchive={handleUnarchiveConversation}
        onDelete={requestDelete}
        onMarkUnread={handleMarkConversationUnread}
        onMarkRead={handleMarkConversationRead}
        onPinToggle={handleTogglePinConversation}
        onRename={handleRenameConversation}
      />
    ) : null);

  const { commandPalette, mergedSections, handleItemSelect } =
    useCommandPaletteOrchestrator({
      assistantId,
      assistantName: assistantName ?? undefined,
      conversations,
      activeConversationId: activeConversationId ?? undefined,
      startNewConversation,
      switchConversation: handleSelectConversation,
    });

  const [paletteEverOpened, setPaletteEverOpened] = useState(false);
  useEffect(() => {
    if (commandPalette.isOpen && !paletteEverOpened) {
      setPaletteEverOpened(true);
    }
  }, [commandPalette.isOpen, paletteEverOpened]);

  const withActiveConversation =
    (action: (conversation: Conversation) => void) => () => {
      if (activeConversation) {
        action(activeConversation);
      }
    };

  useCadetCommands({
    newConversation: () => {
      startNewConversation();
    },
    currentConversation: () => {
      if (!activeConversationId) {
        return;
      }

      if (conversationIdForPath(location.pathname) !== activeConversationId) {
        void navigate(routes.conversation(activeConversationId, keptAppId()));
      }
      requestComposerFocus();
    },
    markCurrentUnread: withActiveConversation(handleMarkConversationUnread),
    togglePinConversation: withActiveConversation(handleTogglePinConversation),
    markAllRead: () => {
      void handleMarkAllReadInGroup(conversations);
    },
    find: () => {
      useCommandPaletteStore.getState().toggle();
    },
    sidebarToggle: () => {
      toggleSidebar();
    },
    commandPalette: () => {
      void openCommandPaletteWindow()
        .then((opened) => {
          if (!opened) {
            useCommandPaletteStore.getState().toggle();
          }
        })
        .catch(() => {
          useCommandPaletteStore.getState().toggle();
        });
    },
    previousConversation: () => {
      if (!activeConversationId || conversations.length === 0) {
        return;
      }
      const idx = conversations.findIndex(
        (c) => c.conversationId === activeConversationId,
      );
      const prev = conversations[idx - 1];
      if (prev) {
        handleSelectConversation(prev.conversationId);
      }
    },
    nextConversation: () => {
      if (!activeConversationId || conversations.length === 0) {
        return;
      }
      const idx = conversations.findIndex(
        (c) => c.conversationId === activeConversationId,
      );
      const next = conversations[idx + 1];
      if (next) {
        handleSelectConversation(next.conversationId);
      }
    },
    openConversation: (command) => {
      if (command.kind === "openConversation") {
        handleSelectConversation(command.conversationId);
      }
    },
    openLibrary: () => {
      void navigate(routes.library.root);
    },
    openIdentity: () => {
      void navigate(routes.identity);
    },
    navigateBack: () => {
      navigate(-1);
    },
    navigateForward: () => {
      navigate(1);
    },
    zoomIn: () => {
      document.body.style.zoom = String(
        parseFloat(document.body.style.zoom || "1") + 0.1,
      );
    },
    zoomOut: () => {
      document.body.style.zoom = String(
        Math.max(0.5, parseFloat(document.body.style.zoom || "1") - 0.1),
      );
    },
    actualSize: () => {
      document.body.style.zoom = "1";
    },
    popOut: () => {
      if (!activeConversationId) {
        return;
      }
      void openPopoutWindow(activeConversationId);
    },
  });

  const isOnConversationRoute = isConversationPath(location.pathname);
  const documentHeaderVisible = useDocumentHeaderVisible();
  const sidebarActiveConversationId = isOnConversationRoute
    ? (activeConversationId ?? undefined)
    : undefined;

  const openAppFromChat = useOpenAppFromChat();
  const activeAppId = useViewerStore.use.activeAppId();

  const handleInspectConversation = useCallback(
    (conversation: Conversation) => {
      void navigate(routes.inspect(conversation.conversationId));
    },
    [navigate],
  );

  const handleOpenInNewWindow = useCallback(
    (conversation: Conversation) => {
      if (electron) {
        void openPopoutWindow(conversation.conversationId);
      } else {
        window.open(routes.conversation(conversation.conversationId), "_blank");
      }
    },
    [electron],
  );

  const renderSideMenu = (args: SideMenuRenderArgs): ReactNode => (
    <AssistantSideMenu
      assistantId={assistantId ?? ""}
      assistantName={assistantName}
      collapsed={args.collapsed}
      variant={args.variant}
      width={args.width}
      onWidthChange={args.onWidthChange}
      conversations={conversations}
      isLoadingConversations={isLoadingConversations}
      conversationsFailed={conversationsFailed}
      onRetryConversations={retryConversations}
      conversationGroups={conversationGroups}
      activeConversationId={sidebarActiveConversationId}
      processingConversationIds={processingConversationIds}
      attentionConversationIds={attentionConversationIds}
      onSelectConversation={handleSelectConversation}
      onStartNewConversation={startNewConversation}
      isIntelligenceActive={isIdentityActive}
      onOpenIntelligence={handleOpenIdentity}
      activeAppId={activeAppId ?? undefined}
      onOpenApp={openAppFromChat}
      onPinConversation={handleTogglePinConversation}
      onRenameConversation={handleRenameConversation}
      onArchiveConversation={handleArchiveConversation}
      onUnarchiveConversation={handleUnarchiveConversation}
      onDeleteConversation={requestDelete}
      onMarkConversationUnread={handleMarkConversationUnread}
      onMarkConversationRead={handleMarkConversationRead}
      onCreateGroup={handleRequestCreateEmptyGroup}
      onRenameGroup={handleRequestRenameGroup}
      onDeleteGroup={handleDeleteGroup}
      onMarkAllReadInGroup={handleMarkAllReadInGroup}
      onArchiveAllInGroup={requestArchiveAll}
      onOpenInNewWindow={isNative ? undefined : handleOpenInNewWindow}
      onInspect={handleInspectConversation}
      onMoveToGroup={handleMoveToGroup}
      onCreateGroupInto={handleRequestCreateGroup}
      onRemoveFromGroup={handleRemoveFromGroup}
      leadingAction={
        args.variant === "overlay" ? (
          <AssistantDesktopAffordance onToggle={args.onClose} />
        ) : undefined
      }
      notificationsAction={
        args.variant === "overlay" ? topBarAccessory : undefined
      }
      footerAction={
        <PreferencesMenu
          assistantId={assistantId}
          assistantVersion={assistantVersion}
          activeConversationId={activeConversationId}
          triggerVariant={args.variant === "overlay" ? "pill" : "item"}
        />
      }
      onClose={args.onClose}
    />
  );

  const mainRoomClass =
    voiceRoomVisible && isMobile
      ? "blur-sm opacity-40 transition-[filter,opacity]"
      : "";

  return (
    <>
      {}
      {!isPopout && isMobile ? <VoiceSessionPillHost variant="row" /> : null}

      {!isPopout && !documentHeaderVisible && (
        <ChatLayoutHeader
          isMobile={isMobile}
          drawerOpen={drawerOpen}
          collapsed={effectiveCollapsed}
          sidebarWidth={sidebarWidth}
          toggleSidebar={toggleSidebar}
          topBarCenter={topBarCenter}
          mobileTopBar={mobileTopBar}
          topBarRightLeading={isMobile ? null : <VoiceSessionPillHost />}
          topBarRightSlot={
            <>
              {topBarRightSlot}
              {topBarPill}
              {!isMobile && <AssistantDesktopAffordance />}
              {topBarAccessory}
            </>
          }
          canGoBack={canGoBack}
          canGoForward={canGoForward}
          onGoBack={handleGoBack}
          onGoForward={handleGoForward}
        />
      )}

      {!isPopout && electron ? (
        <div className="flex shrink-0 flex-col gap-2 empty:hidden">
          <StatusBanner placement="electron" />
          <RuntimeUpgradeBanner
            assistantId={assistantId}
            currentVersion={assistantVersion}
            placement="electron"
          />
        </div>
      ) : null}

      <ChatLayoutFrame
        isPopout={isPopout}
        mainRoomClass={mainRoomClass}
        routeContentInert={voiceRoomVisible || sleepStageVisible}
        desktopNavigation={
          <aside
            id="chat-side-menu"
            className="w-fit shrink-0 overflow-hidden"
            aria-label={t("chatLayout.navigationAria")}
          >
            {renderSideMenu({
              collapsed: effectiveCollapsed,
              variant: "rail",
              width: sidebarWidth,
              onWidthChange: handleSidebarWidthChange,
            })}
          </aside>
        }
        desktopPreview={<AssistantDesktopPreview />}
        sleepStage={<AssistantSleepStage />}
        popoutVoiceSession={<VoiceSessionPillHost variant="standalone" />}
        desktopVoiceRoom={<VoiceRoom variant="content" />}
        mobileDrawer={
          drawerGestures.present ? (
            <div
              ref={drawerRef}
              className="fixed inset-0"
              style={{
                zIndex: 40,

                transform: drawerOpen
                  ? `translateX(${drawerGestures.dragOffset}px)`
                  : "translateX(-100%)",
                transition: drawerGestures.isDragging
                  ? "none"
                  : `transform ${EDGE_SWIPE_SLIDE_MS}ms ${EDGE_SWIPE_EASING}`,

                touchAction: "pan-y",

                pointerEvents: drawerGestures.exiting ? "none" : undefined,
              }}
              onTouchStart={drawerGestures.onTouchStart}
              onTouchMove={drawerGestures.onTouchMove}
              onTouchEnd={drawerGestures.onTouchEnd}
              onTouchCancel={drawerGestures.onTouchCancel}
              role="dialog"
              aria-modal="true"
              aria-label={t("chatLayout.navigationAria")}
              data-state={drawerOpen ? "open" : "closed"}
            >
              {}
              <aside
                id="chat-side-menu"
                className="relative flex h-full w-full flex-col shadow-xl"
                style={{
                  background: DRAWER_SURFACE_BACKGROUND,
                  zIndex: 50,
                  paddingTop:
                    "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))",
                  paddingLeft:
                    "var(--safe-area-inset-left, env(safe-area-inset-left, 0px))",
                }}
              >
                <StatusBanner />
                {renderSideMenu({
                  collapsed: false,
                  variant: "overlay",
                  onClose: closeDrawer,
                })}
              </aside>
            </div>
          ) : null
        }
      />

      {}
      {isFocused ? <ResearchResultsOverlay /> : null}
      {}
      {isMobile ? <VoiceRoom variant="sheet" /> : null}
      {}
      {}
      <AssistantEmailIntro />
      {}
      <OnboardingAvatarApplier />

      <RenameDialogFromStore assistantId={assistantId} />
      <ArchiveAllConfirmDialog
        pending={pendingArchiveAll}
        onConfirm={confirmArchiveAll}
        onCancel={cancelArchiveAll}
      />
      <DeleteConversationConfirmDialog
        pending={pendingDeleteConversation}
        onConfirm={confirmDelete}
        onCancel={cancelDelete}
      />
      <GroupNameDialogFromStore
        createGroup={createGroup}
        renameGroup={renameGroup}
        moveToGroup={handleMoveToGroup}
      />
      {commandPalette.isOpen || paletteEverOpened ? (
        <LazyBoundary>
          <CommandPalette
            isOpen={commandPalette.isOpen}
            onClose={commandPalette.close}
            query={commandPalette.query}
            onQueryChange={commandPalette.setQuery}
            highlightTokens={commandPalette.searchTokens}
            selectedIndex={commandPalette.selectedIndex}
            sections={mergedSections}
            isSearching={commandPalette.isSearching}
            onItemSelect={handleItemSelect}
            onKeyDown={commandPalette.handleKeyDown}
          />
        </LazyBoundary>
      ) : null}
    </>
  );
}
