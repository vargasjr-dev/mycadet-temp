import fs from "fs";
import path from "path";

const DOCS_APP_DIR = path.join(process.cwd(), "src", "app", "docs");

/**
 * Routes whose page only issues a permanentRedirect. Redirect targets belong
 * in the sitemap and the agent-markdown mirrors; the stubs themselves do not.
 */
export const REDIRECT_STUB_ROUTES: ReadonlySet<string> = new Set([
  "/docs/getting-started/key-concepts",
]);

/** A routable docs page: its on-disk page file and the URL route it serves. */
export interface DiscoveredDocsPage {
  pageFile: string;
  route: string;
}

// Next treats underscore-prefixed folders as private. %5F is the URL-encoded
// underscore, used on disk to register an _-prefixed URL segment as a real
// route (e.g. %5Fmd serves /docs/_md), so it is just as private here.
function isPrivateSegment(name: string): boolean {
  return name.startsWith("_") || name.toLowerCase().startsWith("%5f");
}

// The api subtree directly under /docs holds route handlers, not pages.
function isApiRoute(route: string): boolean {
  return route === "/docs/api" || route.startsWith("/docs/api/");
}

/**
 * Recursively finds all page files under src/app/docs and pairs each with its
 * /docs/... URL route. Strips route groups like (documentation) and
 * (releases), skips dynamic segments and private folders (underscore-prefixed
 * like _components, including the URL-encoded %5F form like %5Fmd), and
 * excludes the /docs/api subtree. Redirect stubs are included; consumers that
 * must not surface them filter with REDIRECT_STUB_ROUTES.
 */
export function discoverDocsPages(
  dir: string = DOCS_APP_DIR,
): DiscoveredDocsPage[] {
  return walk(dir, "/docs")
    .filter((page) => !isApiRoute(page.route))
    .sort((a, b) => (a.route < b.route ? -1 : a.route > b.route ? 1 : 0));
}

/** Routes of every discovered docs page, sorted. */
export function discoverDocsRoutes(dir: string = DOCS_APP_DIR): string[] {
  return discoverDocsPages(dir).map((page) => page.route);
}

function walk(dir: string, basePath: string): DiscoveredDocsPage[] {
  const pages: DiscoveredDocsPage[] = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return pages;
  }

  const pageEntry = entries.find(
    (e) => e.isFile() && (e.name === "page.tsx" || e.name === "page.ts"),
  );
  if (pageEntry) {
    pages.push({ pageFile: path.join(dir, pageEntry.name), route: basePath });
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const name = entry.name;

    if (name.startsWith("[") || isPrivateSegment(name)) {
      continue;
    }

    const isRouteGroup = name.startsWith("(") && name.endsWith(")");
    const segment = isRouteGroup ? "" : `/${name}`;

    pages.push(...walk(path.join(dir, name), `${basePath}${segment}`));
  }

  return pages;
}

export function fetchConstitutionContent(): string {
  return fs.readFileSync("../../CONSTITUTION.md").toString();
}

export function fetchGlossaryContent(): string {
  return fs.readFileSync("../../GLOSSARY.md").toString();
}


// The legal pages render from markdown under src/content/legal — the
// hand-maintained JSX bodies became prose files so the copy is editable
// without touching a component. The allowlist keeps a stray path segment
// from turning into a file read.
const LEGAL_PAGES: ReadonlySet<string> = new Set([
  "privacy-policy",
  "terms-of-use",
]);

export function fetchLegalPageContent(name: string): string {
  if (!LEGAL_PAGES.has(name)) {
    throw new Error(`Unknown legal page: ${name}`);
  }
  return fs
    .readFileSync(
      path.join(process.cwd(), "src", "content", "legal", `${name}.md`),
    )
    .toString();
}
