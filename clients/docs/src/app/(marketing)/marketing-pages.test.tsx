/**
 * The marketing pages (community, downloads) are ported from mycadet-cloud
 * so this app can grow into the open-source marketing frontend. These tests
 * pin the invariants Vargas's TODO list called out: the inviting gradient,
 * the Discord-blurple button, the greeting characters, and the downloads
 * grid that came over with the page.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
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
    expect(grid).toContain("curl -fsSL https://mycadet.ai/install.sh | bash");
    for (const id of [
      "iphone",
      "android",
      "mac",
      "chrome",
      "windows",
      "terminal",
    ]) {
      expect(grid).toContain(`"${id}"`);
    }
  });

  test("marks all three desktop apps ready for download", () => {
    // His call on #929: mac, windows, and terminal hand out real
    // download actions; only the pocket/browser cards stay coming-soon.
    expect(grid).toContain('Download for {id === "mac" ? "Mac" : "Windows"}');
    expect(grid).toContain("DESKTOP_DOWNLOAD_URLS");
    expect(grid).not.toContain('windows: "🪟 Coming soon!"');
    expect(grid).not.toContain("Your PC cadet is still in boot camp");
  });

  test("pipes over emdashes in the metadata title, real description", () => {
    expect(page).toContain('title: "Downloads | Cadet"');
    expect(page).toContain("Download Cadet for Mac, Windows, and Terminal");
    // The in-training language stays on the page content, not metadata.
    expect(page).toContain("in training");
  });

  test("references assets under the /docs ingress prefix", () => {
    expect(grid).toContain('"/docs/qr-iphone.png"');
    expect(grid).toContain('"/docs/qr-android.png"');
  });
});

describe("index page is the landing", () => {
  const page = read("src", "app", "(marketing)", "page.tsx");

  test("replaces the /docs redirect with the cloud landing", () => {
    expect(page).toContain("CharacterAvalanche");
    expect(page).toContain("PreviewTitle");
    expect(page).toContain("LandingChapters");
    expect(page).toContain("The personal agent that handles your");
    // The session-aware CTA stays in the cloud for now; a static
    // "Hatch Yours" sits in its slot.
    expect(page).toContain("Hatch Yours");
  });

  test("the chapters stay behind the secret preview knock", () => {
    expect(read("src", "lib", "preview.ts")).toContain("cadet-preview");
    expect(read("src", "components", "preview-title.tsx")).toContain(
      "KNOCKS = 7",
    );
  });

  test("every metadata title pipes over emdashes throughout the app", () => {
    // His call on #929: "I like pipes over emdashes for metadata titles
    // throughout — no em-dash metadata separator survives the sweep.
    const offenders: string[] = [];
    for (const dir of ["src/app"]) {
      const stack = [path.join(process.cwd(), dir)];
      while (stack.length) {
        const dir = stack.pop()!;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            stack.push(full);
          } else if (entry.name.endsWith(".tsx")) {
            for (const line of readFileSync(full, "utf8").split("\n")) {
              if (/title: "[^"]* - /.test(line)) {
                offenders.push(`${full}: ${line.trim()}`);
              }
            }
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
