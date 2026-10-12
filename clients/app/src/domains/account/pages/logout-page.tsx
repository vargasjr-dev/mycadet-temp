import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router";

import { useTranslation } from "@app/i18n";
import { AccountHeading } from "@app/components/account/account-form";
import { AccountShell } from "@app/components/account/account-shell";
import { sanitizeReturnTo } from "@web/domains/account/return-to";
import { hardNavigate } from "@web/lib/auth/hard-navigate";
import { useAuthStore } from "@web/stores/auth-store";
import { routes } from "@web/utils/routes";

export function LogoutPage() {
  const { t } = useTranslation("account");
  const [searchParams] = useSearchParams();
  const logout = useAuthStore.use.logout();
  const logoutInitiated = useRef(false);

  useEffect(() => {
    if (logoutInitiated.current) {
      return;
    }
    logoutInitiated.current = true;

    const returnTo = sanitizeReturnTo(
      searchParams.get("returnTo"),
      routes.account.login,
    );

    // If returnTo is an absolute URL (cross-origin), redirect there directly.
    // Otherwise, redirect to login with returnTo as a param.
    const target =
      returnTo.startsWith("http") || returnTo === routes.account.login
        ? returnTo
        : `${routes.account.login}?returnTo=${encodeURIComponent(returnTo)}`;

    let cancelled = false;
    logout().then(
      () => {
        if (!cancelled) {
          hardNavigate(target);
        }
      },
      () => {
        if (!cancelled) {
          hardNavigate(target);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [logout, searchParams]);

  return (
    <AccountShell>
      <AccountHeading title={t("logoutPage.title")} />
    </AccountShell>
  );
}
