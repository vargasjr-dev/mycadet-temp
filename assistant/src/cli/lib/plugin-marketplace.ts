/**
 * Shared plugin source schemas and types for catalog-backed installs.
 *
 * The old local marketplace manifest (`plugins/marketplace.json`) and its
 * GitHub fetcher are gone: the installable catalog is Cadet Cloud's
 * (`GET /v1/plugins`, see {@link ./plugin-catalog-cloud}). What remains here
 * is the contract every catalog source must satisfy when a name resolves to
 * install coordinates.
 *
 * Every external source pins an explicit `ref` that MUST be a full commit
 * SHA: the fetched code is locked to an immutable revision. Tags and branches
 * are rejected because they are mutable — an upstream owner could retag/repoint
 * them to attacker code that the daemon would then `import()` (the install
 * tree is dynamically loaded). A SHA cannot be repointed, so a reviewed
 * catalog fully determines what gets executed.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Source schemas (subset of the Claude Code marketplace schema)
// ---------------------------------------------------------------------------

/** `owner/repo`, kebab/underscore/dot segments — matches GitHub's slug rules. */
const REPO_SLUG_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
/** Install name: a single kebab-case path segment (same rule as the CLI). */
export const PLUGIN_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
/**
 * Full Git commit SHA — 40 hex chars (SHA-1) or 64 (SHA-256). External
 * catalog refs must be a complete object name so the install is pinned to
 * an immutable revision; abbreviated SHAs, tags, and branches are all mutable
 * or ambiguous and are rejected.
 */
const COMMIT_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

export const githubSourceSchema = z.object({
  /** Discriminator for a reviewed external repository. */
  source: z.literal("github"),
  /** `owner/repo` of the external plugin repository. */
  repo: z.string().regex(REPO_SLUG_RE, "expected an `owner/repo` slug"),
  /**
   * Directory within the repo that holds the plugin root. Omitted / empty
   * means the repository root. Must not escape the repo.
   */
  path: z
    .string()
    .refine(
      (p) => !p.split(/[/\\]/).some((seg) => seg === ".." || seg === ""),
      "path must be a clean repo-relative directory",
    )
    .optional(),
  /**
   * Immutable revision to fetch the plugin from. Must be a full commit SHA:
   * tags and branches are mutable, so allowing them would let an upstream
   * owner retarget a curated entry at code the daemon later `import()` (RCE).
   * A full SHA pins the install to exactly the reviewed bytes.
   */
  ref: z
    .string()
    .regex(
      COMMIT_SHA_RE,
      "expected a full commit SHA (40 or 64 hex chars); tags and branches are mutable and not allowed",
    ),
});

export const marketplaceSourceSchema = githubSourceSchema;

export const mcpIntegrationSchema = z.object({
  kind: z.literal("mcp"),
  displayName: z.string().min(1),
  documentationUrl: z.string().url(),
  verifiedAt: z.iso.date(),
  verification: z.literal("documentation-only"),
  setup: z.object({
    mode: z.enum(["oauth", "manual"]),
    instructions: z.string().min(1),
  }),
  /** Filename under the web client's bundled integration-image directory. */
  logo: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/),
  /**
   * Where the integrations catalog files the entry. Any string at this
   * boundary: a catalog newer than this build can name a category it does not
   * know, and one unfamiliar slug must not reject the whole catalog. Clients
   * normalize against the shared vocabulary; the bundled inventory test holds
   * every entry in this repo to it.
   */
  category: z.string().optional(),
  /** Existing main OAuth provider used to group a related MCP connection. */
  oauthProvider: z.string().regex(PLUGIN_NAME_RE).optional(),
});

export const marketplaceEntrySchema = z.object({
  /** Install name. `assistant plugins install <name>` resolves to this entry. */
  name: z.string().regex(PLUGIN_NAME_RE, "expected a kebab-case install name"),
  source: marketplaceSourceSchema,
  description: z.string().optional(),
  /** Free-form grouping hint (e.g. `productivity`). Informational. */
  category: z.string().optional(),
  homepage: z.string().optional(),
  license: z.string().optional(),
  /**
   * A single curated author/curator emoji shown as the plugin's icon (e.g. on
   * the marketing catalog). Not a URL or file path — bounded to a short
   * emoji-length string; a multi-code-point emoji (skin tone, ZWJ sequence)
   * still fits comfortably under the cap.
   */
  icon: z
    .string()
    .refine(
      (s) => [...s].length <= 8 && !/[/\\]|^https?:/i.test(s),
      "expected a short emoji, not a URL or path",
    )
    .optional(),
  integration: mcpIntegrationSchema.optional(),
});

/** A single reviewed plugin entry. */
export type MarketplaceEntry = z.infer<typeof marketplaceEntrySchema>;

/** Concrete GitHub coordinates an entry resolves to for install. */
export interface ResolvedGitHubPluginSource {
  readonly kind: "github";
  readonly owner: string;
  readonly repo: string;
  /** Directory within the repo holding the plugin root; `""` = repo root. */
  readonly path: string;
  /** Git ref to fetch from. */
  readonly ref: string;
}

export type ResolvedPluginSource = ResolvedGitHubPluginSource;
