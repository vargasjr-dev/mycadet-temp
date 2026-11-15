/**
 * The consent screen's agreement sentences render the locale's rich-text tag
 * as a real anchor around the policy name — never the literal tag text (the
 * regression that shipped the raw `<link>`/`<0>` markers to users).
 *
 * Rendered through the exported sentence component alone: the full screen
 * pulls the auth store, whose mock.module mocks leak across a shared bun test
 * run.
 */
import { createInstance, type i18n } from "i18next";
import ICU from "i18next-icu";
import { render, screen } from "@testing-library/react";
import { expect, test } from "bun:test";

import { FALLBACK_CATALOGS } from "../../i18n/catalogs";
import { i18nextInitOptions } from "../../i18n/config";
import consentCatalog from "@app/i18n/locales/en/consent.json";
import { AgreementSentence } from "./review-terms-screen";
import { AppI18nContext } from "@app/i18n/provider";

function makeInstance(): i18n {
  const instance = createInstance();
  instance.use(new ICU()).init({
    ...i18nextInitOptions("en", { en: FALLBACK_CATALOGS }),
    initAsync: false,
  });
  instance.addResourceBundle("en", "consent", consentCatalog, true, true);
  return instance;
}

test("the agreement sentences render real policy links", () => {
  render(
    <AppProvider>
      <AgreementSentence
        href="https://www.mycadet.ai/docs/terms-of-use"
        policy="Terms of Service"
      />
      <AgreementSentence
        href="https://www.mycadet.ai/docs/privacy-policy"
        policy="the Privacy Policy"
      />
    </AppProvider>,
  );

  // No literal rich-text tags leak into the sentence.
  expect(screen.queryByText("<link>")).toBeNull();
  expect(screen.queryByText("<0>")).toBeNull();

  // The policy name IS the link, pointing at the legal page.
  const tosLink = screen.getByRole("link", { name: "Terms of Service" });
  expect(tosLink.getAttribute("href")).toBe(
    "https://www.mycadet.ai/docs/terms-of-use",
  );
  const privacyLink = screen.getByRole("link", {
    name: "the Privacy Policy",
  });
  expect(privacyLink.getAttribute("href")).toBe(
    "https://www.mycadet.ai/docs/privacy-policy",
  );
});

function AppProvider({ children }: { children: React.ReactNode }) {
  return (
    <AppI18nContext.Provider value={makeInstance()}>
      {children}
    </AppI18nContext.Provider>
  );
}
