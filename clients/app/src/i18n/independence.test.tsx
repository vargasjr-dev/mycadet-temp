import { afterEach, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import webI18next from "i18next";
import { I18nextProvider } from "react-i18next";

import { WelcomeScreenCopy } from "@app/components/auth-welcome-screen";
import { RootHydrateFallback } from "@app/components/root-hydrate-fallback";
import { changeLocale, t, Trans, useTranslation } from "@app/i18n";
import { i18next } from "@app/i18n/instance";

function AccountCopy() {
  const { t } = useTranslation("account");
  return (
    <>
      <span>{t("signupScreen.haveAccountPrompt")}</span>
      <Trans ns="common" i18nKey="notFound.title" />
    </>
  );
}

afterEach(async () => {
  cleanup();
  await changeLocale("en");
  await webI18next.changeLanguage("en");
  localStorage.removeItem("device:locale");
});

test("app hooks and Trans use app language even inside a web provider", async () => {
  await changeLocale("es");
  await webI18next.changeLanguage("en");
  render(
    <I18nextProvider i18n={webI18next}>
      <AccountCopy />
    </I18nextProvider>,
  );
  expect(screen.getByText("Página no encontrada")).toBeDefined();
  expect(webI18next.t("notFound.title")).toBe("Page not found");
  expect(
    screen.getByText(
      i18next.getFixedT(null, "account")("signupScreen.haveAccountPrompt"),
    ),
  ).toBeDefined();
  await webI18next.changeLanguage("ru");
  expect(t("notFound.title")).toBe("Página no encontrada");
});

test("app and web own separate resource stores", () => {
  i18next.addResource("en", "common", "appIsolationProbe", "App only");
  expect(i18next.getResource("en", "common", "appIsolationProbe")).toBe(
    "App only",
  );
  expect(
    webI18next.getResource("en", "common", "appIsolationProbe"),
  ).toBeUndefined();
});

test("app hydration fallback uses app locale while web remains English", async () => {
  await changeLocale("es");
  await webI18next.changeLanguage("en");
  render(
    <I18nextProvider i18n={webI18next}>
      <RootHydrateFallback />
    </I18nextProvider>,
  );
  expect(screen.getByRole("status").getAttribute("aria-label")).toBe(
    "Cargando",
  );
  expect(webI18next.t("rootHydrateFallback.loadingAria")).toBe("Loading");
});

test("login welcome copy uses app language inside a web provider", async () => {
  await changeLocale("es");
  await webI18next.changeLanguage("en");
  render(
    <I18nextProvider i18n={webI18next}>
      <WelcomeScreenCopy>
        <button>Sign in</button>
      </WelcomeScreenCopy>
    </I18nextProvider>,
  );
  expect(screen.getByRole("heading").textContent).toBe(
    t("account:welcome.title"),
  );
  expect(screen.getByRole("heading").textContent).not.toBe("Welcome to Cadet");
});
