/**
 * The billing settings page hands off to the cloud's account pages — plan
 * management, payment methods, invoices, and usage all live there. The page
 * carries no billing machinery of its own.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import { BillingPage } from "@/domains/settings/billing/billing-page";

describe("billing-page", () => {
  afterEach(cleanup);

  test("links out to the cloud's billing and account pages", () => {
    render(
      <MemoryRouter>
        <BillingPage />
      </MemoryRouter>,
    );

    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(2);
    const hrefs = links.map((link) => link.getAttribute("href") ?? "");
    expect(hrefs.some((href) => href.includes("/account/billing"))).toBe(true);
    expect(hrefs.some((href) => href.includes("/account/profile"))).toBe(true);
  });
});
