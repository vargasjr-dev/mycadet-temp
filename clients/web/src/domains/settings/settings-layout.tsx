import { LogIn, LogOut } from "lucide-react";
import { useCallback, useEffect, useMemo } from "react";
import { Outlet, useLocation } from "react-router";

import { useTranslation } from "@/i18n";
import { useOnboardingLogin } from "@/hooks/use-onboarding-login";
import { handleLogout } from "@/lib/auth/handle-logout";
import { useSupportsCredentialsSettings } from "@/lib/backwards-compat/use-supports-credentials-settings";
import { isBrowserNotificationHost } from "@/runtime/notifications";
import { useIsNativeAndroid } from "@/runtime/platform-detection";
import { useHasCloudSession } from "@/stores/auth-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useTitleBarStore } from "@/stores/title-bar-store";
import { routes } from "@/utils/routes";
import { SETTINGS_SIDEBAR } from "@/utils/settings-navigation";
import { SidebarShell } from "@/components/sidebar-shell";
import { SidebarTree, type SidebarItem } from "@/components/sidebar-tree";

/**
 * React Router layout route for `/assistant/settings/*`.
 *
 * Renders the SidebarShell (responsive overlay panel with sidebar
 * navigation) and an `<Outlet />` for the active settings tab page.
 */
export function SettingsLayout() {
  // Settings brings its own full-screen chrome; the Windows in-title-bar
  // menu bar yields while it's up (inert off the Windows shell, where the
  // menu bar doesn't render anyway).
  const setWindowsMenuBarSuppressed =
    useTitleBarStore.use.setWindowsMenuBarSuppressed();
  useEffect(() => {
    setWindowsMenuBarSuppressed(true);
    return () => setWindowsMenuBarSuppressed(false);
  }, [setWindowsMenuBarSuppressed]);
  const { t } = useTranslation("settings");
  const notificationSettingsAvailable =
    useIsNativeAndroid() || isBrowserNotificationHost();
  const activeAssistantId = useResolvedAssistantsStore.use.activeAssistantId();
  // The Credentials tab needs routes that only newer assistants
  // serve (v0.8.1+ / v0.10.8+); an older assistant 404s them, so hide the
  // tabs rather than render a dead error page. Scoped to the active assistant
  // so a stale cross-store version can't light a tab mid-switch.
  const supportsCredentials = useSupportsCredentialsSettings(activeAssistantId);
  //   // inspector affordances. Hides the tab rather than leaving a route whose
  // only content-producing affordance (the per-message toggle) is hidden.
  // The Usage item is never hidden: the usage page reads from the local
  // daemon and works for every assistant. Billing management moved off web
  // (the cloud's account pages own it), so the label is just "Usage".
  const { pathname } = useLocation();
  // Show Log Out when a cloud session exists, Log In otherwise.
  const hasCloudSession = useHasCloudSession();
  const { login } = useOnboardingLogin();

  const getSidebarLabel = useCallback(
    (id: string, defaultLabel: string) => {
      switch (id) {
        case "assistant-status":
          return t("sidebar.general", "General");
        case "model":
          return t("sidebar.model", "Models & Services");
        case "integrations":
          return t("sidebar.integrations", "Integrations");
        case "credentials":
          return t("sidebar.credentials", "Credentials");
        case "notifications":
          return t("sidebar.notifications", "Notifications");
        case "voice":
          return t("sidebar.voice", "Voice");
        case "sounds":
          return t("sidebar.sounds", "Sounds");
        case "privacy":
          return t("sidebar.privacy", "Permissions & Privacy");
        case "billing":
          return t("sidebar.usage", "Usage");
        case "community":
          return t("sidebar.community", "Community");
        case "debug":
          return t("sidebar.debug", "Debug");
        default:
          return defaultLabel;
      }
    },
    [t],
  );

  const filteredItems = useMemo(
    () =>
      SETTINGS_SIDEBAR.filter((item) => {
        if (item.id === "notifications" && !notificationSettingsAvailable) {
          return false;
        }
        if (item.id === "credentials" && !supportsCredentials) {
          return false;
        }
        return true;
      }).map((item) => ({
        ...item,
        label: getSidebarLabel(item.id, item.label),
      })),
    [notificationSettingsAvailable, supportsCredentials, getSidebarLabel],
  );

  const bottomItems = useMemo<SidebarItem[]>(() => {
    const items: SidebarItem[] = [];
    // The auth action is pinned to the very bottom of the nav.
    items.push(
      hasCloudSession
        ? {
            id: "logout",
            label: t("sidebar.logout", "Log Out"),
            icon: LogOut,
            onSelect: () => void handleLogout(),
          }
        : {
            id: "login",
            label: t("sidebar.login", "Log In"),
            icon: LogIn,
            onSelect: () => void login(),
          },
    );
    return items;
  }, [hasCloudSession, login, t]);

  const pageTitle = useMemo(() => {
    if (pathname === routes.settings.root) {
      return t("sidebar.title", "Settings");
    }
    const match = SETTINGS_SIDEBAR.find(
      (item) => pathname === item.href || pathname.startsWith(item.href + "/"),
    );
    if (match) {
      return getSidebarLabel(match.id, match.label);
    }
    return t("sidebar.title", "Settings");
  }, [pathname, t, getSidebarLabel]);

  return (
    <SidebarShell
      backHref={routes.assistant}
      sidebar={
        <SidebarTree
          items={filteredItems}
          bottomItems={bottomItems}
          indexPath={routes.settings.root}
        />
      }
      title={pageTitle}
      // The settings root's index child is the General page, which a narrow
      // viewport never shows: the nav list occupies the whole screen and
      // General is reached by tapping through to it.
      menuReplacesContentOnMobile
    >
      <Outlet />
    </SidebarShell>
  );
}
