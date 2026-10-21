import {
  ChevronDown,
  ChevronUp,
  CircleUser,
  MessageSquareText,
  Settings as SettingsIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";

import {
  BottomSheet,
  Button,
  PanelItem,
  Popover,
  SideMenu,
  useSideMenuCollapsed,
} from "@mycadet/design-library";

import {
  prefetchShareFeedbackModal,
  ShareFeedbackModalLazy,
} from "@/components/share-feedback-modal-lazy";
import { useTouchMobile } from "@/hooks/use-touch-mobile";
import { useCloudGate } from "@/hooks/use-cloud-gate";
import { prefetchRoute } from "@/lib/prefetch-route";
import { isElectron } from "@/runtime/is-electron";
import { useIsAuthenticated } from "@/stores/auth-store";
import { routes } from "@/utils/routes";

import { SIDEBAR_PILL_GAP_CLASSES } from "@/components/sidebar-nav-geometry";
import { useTranslation } from "@/i18n";

/**
 * The trigger names the menu it opens, never the signed-in account. This is a
 * settings entry point rather than a profile row, and the account's identity
 * belongs on the Settings page the menu links to.
 */

export interface PreferencesMenuProps {
  assistantId?: string | null;
  assistantVersion?: string | null;
  activeConversationId?: string | null;
  /**
   * Trigger presentation. `item` is the labeled side-menu footer row (rail);
   * `pill` is a floating rounded button for the mobile overlay's action row.
   */
  triggerVariant?: "item" | "pill";
}

export function PreferencesMenu({
  assistantId,
  assistantVersion,
  activeConversationId,
  triggerVariant = "item",
}: PreferencesMenuProps) {
  const { t } = useTranslation("chat");
  /* From the menu rather than a prop: this trigger has to reduce to a tile at
     the same moment every other rail entry does, and a threaded prop is that
     one fact derived twice, free to disagree with the menu rendering around
     it. The `pill` variant ignores it, and only renders on the overlay, where
     it reads false regardless. */
  const collapsed = useSideMenuCollapsed();
  const isAuthenticated = useIsAuthenticated();
  const isTouchMobile = useTouchMobile();
  const [isOpen, setIsOpen] = useState(false);
  const [isFeedbackOpen, setIsFeedbackOpen] = useState(false);

  /* Warm the chunks this menu leads to as it opens rather than on the click
     that needs them, so they are usually already there by the time they are
     asked for. Settings is the expensive one: it is two lazy chunks, the
     layout and its landing page, and the router resolves both before it will
     commit, holding the previous screen with no feedback for the whole wait.
     Once per mount: chunks are module-cached after the first fetch. */
  const hasPrefetchedMenuTargets = useRef(false);
  useEffect(() => {
    if (!isOpen || hasPrefetchedMenuTargets.current) {
      return;
    }
    hasPrefetchedMenuTargets.current = true;
    prefetchShareFeedbackModal();
    prefetchRoute(routes.settings.root);
  }, [isOpen]);

  if (!isAuthenticated) {
    return null;
  }

  const closeMenu = () => setIsOpen(false);

  const trigger =
    triggerVariant === "pill" ? (
      /* Solid surface: the pill floats over the scrolling conversation list,
         so it can't be transparent like `ghost`. */
      <Button
        shape="pill"
        variant="ghost"
        /* Sized as the drawer's rows and the New Chat pill beside it: large
           body label, 16px glyph on a phone, and the rows' 8px between glyph
           and label. The glyph is content rather than `leftIcon`, whose box
           the button sizes inline at 14px. The leading inset is the rows'
           8px plus the chip's 4px lead-in to its 16px glyph, less the 1px
           border, so this label starts where the assistant row's does (40px
           in, see `SIDEBAR_MOBILE_CHIP_CLASSES`). */
        className="min-h-[var(--side-menu-tile-size,36px)] min-w-0 gap-2 border border-[var(--border-base)] bg-[var(--surface-lift)] pr-3 pl-[15px] max-md:text-body-large-default"
      >
        <CircleUser aria-hidden className="size-3.5 shrink-0 max-md:size-4" />
        {/* `truncate` is belt-and-braces: the label is a fixed short string,
            but the pill shares its row with New Chat and must never grow
            wide enough to overlap it at narrow viewports. */}
        <span className="min-w-0 truncate">
          {t("preferencesMenu.preferences")}
        </span>
      </Button>
    ) : collapsed ? (
      /* Collapsed, the same tile every other rail entry reduces to: a circle
         at the pill's own height with the glyph centred and no label, its name
         carried by the hover tooltip. A pill is sized by its content, so one
         keeping its label is wider than the collapsed rail and gets clipped
         mid-word, and one with only the label dropped is still a
         content-width capsule with the glyph against its leading edge.
         `SideMenu.Item` owns that whole treatment, and it is what the pinned
         apps above and the section tiles use, so the foot of the rail is drawn
         by the same component as the rest of it.

         No chevron: it says which way the popover will open, and a tile has
         no room for it beside the glyph. */
      <SideMenu.Item
        icon={CircleUser}
        label={t("preferencesMenu.preferences")}
        showCollapsedTooltip
        shape="tile"
        active={isOpen}
        /* `active` is the open-popover surface here, not a location: this
           tile opens a menu over the rail rather than navigating, so it drops
           the `aria-current="page"` a real destination row sets. Mirrors the
           section tiles in `CollapsedGroupIcon`. */
        aria-current={undefined}
        aria-haspopup="dialog"
        data-tour-id="settings"
      />
    ) : (
      /* A pill, matching the identity and pinned-app entries it shares the
         rail with: these are destinations you keep, not rows in a list.
         Distinct from `triggerVariant="pill"` above, which is the mobile
         overlay's floating action button. */
      <PanelItem
        shape="pill"
        /* The popover owns the click, so this row takes no handler of its
           own and needs telling that it is still a control. */
        trigger
        icon={CircleUser}
        label={t("preferencesMenu.preferences")}
        expandChevron={isOpen ? ChevronDown : ChevronUp}
        active={isOpen}
        /* Its label on the line every other rail pill's starts on. */
        className={SIDEBAR_PILL_GAP_CLASSES}
        data-tour-id="settings"
      />
    );

  const content = (
    <PreferencesMenuContent
      onClose={closeMenu}
      onShareFeedback={() => setIsFeedbackOpen(true)}
    />
  );

  return (
    <>
      {isTouchMobile ? (
        <BottomSheet.Root open={isOpen} onOpenChange={setIsOpen}>
          <BottomSheet.Trigger asChild>{trigger}</BottomSheet.Trigger>
          <BottomSheet.Content className="max-h-[85dvh]">
            <BottomSheet.Header className="sr-only">
              <BottomSheet.Title>
                {t("preferencesMenu.preferences")}
              </BottomSheet.Title>
            </BottomSheet.Header>
            <BottomSheet.Body className="pt-0">{content}</BottomSheet.Body>
          </BottomSheet.Content>
        </BottomSheet.Root>
      ) : (
        <Popover.Root open={isOpen} onOpenChange={setIsOpen}>
          <Popover.Trigger asChild>{trigger}</Popover.Trigger>
          <Popover.Content
            side="top"
            align="start"
            sideOffset={8}
            tabIndex={-1}
            onOpenAutoFocus={(event) => {
              const content = event.currentTarget as HTMLElement | null;
              event.preventDefault();
              content?.focus();
            }}
            className="w-64"
          >
            {content}
          </Popover.Content>
        </Popover.Root>
      )}

      {isFeedbackOpen ? (
        <ShareFeedbackModalLazy
          open={isFeedbackOpen}
          onClose={() => setIsFeedbackOpen(false)}
          assistantId={assistantId}
          assistantVersion={assistantVersion}
          activeConversationId={activeConversationId}
        />
      ) : null}
    </>
  );
}

interface PreferencesMenuContentProps {
  onClose: () => void;
  onShareFeedback: () => void;
}

function PreferencesMenuContent({
  onClose,
  onShareFeedback,
}: PreferencesMenuContentProps) {
  const { t } = useTranslation("chat");
  const navigate = useNavigate();
  const cloudGate = useCloudGate();
  return (
    <>
      {(cloudGate === "full" || isElectron()) && (
        <PanelItem
          icon={MessageSquareText}
          label={t("preferencesMenu.shareFeedback")}
          onSelect={() => {
            onClose();
            onShareFeedback();
          }}
        />
      )}

      <PanelItem
        icon={SettingsIcon}
        label={t("preferencesMenu.settings")}
        onSelect={() => {
          onClose();
          navigate(routes.settings.root);
        }}
      />
    </>
  );
}
