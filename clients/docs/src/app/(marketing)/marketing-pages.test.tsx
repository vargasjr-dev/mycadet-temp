/**
 * The marketing pages (community, downloads) are ported from mycadet-cloud
 * so this app can grow into the open-source marketing frontend. These tests
 * pin the invariants Vargas's TODO list called out: the inviting gradient,
 * the Discord-blurple button, the greeting characters, and the downloads
 * grid that came over with the page.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const read = (...p: string[]) =>
  readFileSync(path.join(process.cwd(), ...p), "utf8");

describe("community page", () => {
  const page = read("src", "app", "(marketing)", "community", "page.tsx");
  const css = read("src", "app", "(marketing)", "community", "community.css");

  test("the background is a gradient, never a flat white or black", () => {
    expect(css).toContain("radial-gradient");
    // Both themes get the wash.
    expect(css).toContain(".dark .marketing .community");
  });

  test("the Join Discord button wears Discord's blurple", () => {
    expect(css).toContain("#5865f2");
    expect(page).toContain("btn-discord");
  });

  test("the cast greets you with the three welcome lines", () => {
    expect(page).toContain("Welcome!");
    expect(page).toContain("Glad you're here!");
    expect(page).toContain("Join us!");
    // The pool variant, not the full landing-page avalanche.
    expect(page).toContain("CharacterPool");
    expect(page).not.toContain("CharacterAvalanche");
  });

  test("lives in the marketing route group with the shared chrome", () => {
    const layout = read("src", "app", "(marketing)", "layout.tsx");
    expect(layout).toContain("SiteNav");
    expect(layout).toContain("SiteFooter");
  });
});

describe("downloads page", () => {
  const page = read("src", "app", "(marketing)", "downloads", "page.tsx");
  const grid = read("src", "components", "downloads-grid.tsx");

  test("keeps the cloud page's shape: headline, grid, migrate footnote", () => {
    expect(page).toContain("Your assistant, everywhere");
    expect(page).toContain("<DownloadsGrid />");
    expect(page).toContain("/account/migrate/start");
  });

  test("hands out the install command and every platform card", () => {
    expect(grid).toContain(
      "curl -fsSL https://mycadet.ai/install.sh | bash",
    );
    for (const id of ["iphone", "android", "mac", "chrome", "windows", "terminal"]) {
      expect(grid).toContain(`"${id}"`);
    }
  });

  test("references assets under the /docs ingress prefix", () => {
    expect(grid).toContain('"/docs/qr-iphone.png"');
    expect(grid).toContain('"/docs/qr-android.png"');
  });
});
