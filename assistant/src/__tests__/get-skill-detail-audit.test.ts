/**
 * Tests for `getSkill` — audit enrichment + lineage, zero-leak.
 *
 * Coverage:
 *   - Enriches skillssh skill detail with audit data on success.
 *   - Returns detail without audit data when the audit fetch fails (non-fatal).
 *   - Attributes a plugin-resident skill to its owning plugin.
 *   - Includes sourceConversationId when install-meta records it.
 *   - Omits sourceConversationId when install-meta has none.
 *   - Never exposes lineage on non-assistant-memory origins.
 *
 * Zero-leak: the REAL catalog loader resolves skills seeded into the
 * workspace (a managed skills dir entry, a real plugin directory with a
 * package.json manifest, each carrying a real `install-meta.json`), and the
 * REAL `fetchSkillAudits` runs its HTTP fetch against the requests-mock
 * transport. The former mock asserted the audit call args; these tests
 * assert the real audit URL. The skillssh detail ids are one-segment
 * workspace skill ids with the slash slug living in install-meta.json —
 * through the real loader the id is the on-disk directory name, and the
 * registry slug is install-meta state.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { setConfig } from "./helpers/set-config.js";
import { mockHttp } from "./requests-mock.js";

// Real env: the real getCloudBaseUrl() reads config.cloud.baseUrl — point it
// at a host mockHttp matches by path substring.
setConfig("cloud", { baseUrl: "https://test-cloud.mycadet.ai" });

import { getSkill } from "../daemon/handlers/skills.js";
import { invalidateCatalogCache } from "../skills/catalog-cache.js";
import {
  getWorkspacePluginsDir,
  getWorkspaceSkillsDir,
} from "../util/layout.js";

// ---------------------------------------------------------------------------
// Workspace seeding — the real loader resolves these
// ---------------------------------------------------------------------------

const seededDirs: string[] = [];

/** Seed a managed skill (workspace skills dir entry) with an install-meta.json. */
function seedManagedSkill(
  id: string,
  installMeta: Record<string, unknown> | null,
): string {
  const dir = join(getWorkspaceSkillsDir(), id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${id}\ndescription: seeded test skill\n---\n# ${id}\n`,
  );
  if (installMeta !== null) {
    writeFileSync(
      join(dir, "install-meta.json"),
      JSON.stringify(installMeta, null, 2),
    );
  }
  seededDirs.push(dir);
  return dir;
}

/** Seed a real plugin directory (package.json manifest + one resident skill). */
function seedPluginWithSkill(pluginId: string, skillId: string): string {
  const pluginDir = join(getWorkspacePluginsDir(), pluginId);
  const skillDir = join(pluginDir, "skills", skillId);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(pluginDir, "package.json"),
    JSON.stringify({ name: pluginId, version: "1.0.0" }),
  );
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\nname: ${skillId}\ndescription: seeded plugin skill\n---\n# ${skillId}\n`,
  );
  seededDirs.push(pluginDir);
  return pluginDir;
}

beforeEach(() => {
  invalidateCatalogCache();
});

afterEach(() => {
  for (const dir of seededDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  seededDirs.length = 0;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getSkill — skillssh audit enrichment", () => {
  test("enriches skillssh skill detail with audit data on success", async () => {
    const http = mockHttp();
    seedManagedSkill("lint-skill", {
      origin: "skillssh",
      slug: "acme/tools/lint",
      sourceRepo: "acme/tools",
    });
    // The real fetchSkillAudits runs its HTTP fetch; the audit service
    // response is keyed by skill slug.
    http.on("GET", "add-skill.vercel.sh/audit", {
      status: 200,
      body: {
        lint: {
          ath: { risk: "safe", score: 100, analyzedAt: "2025-06-01T00:00:00Z" },
          socket: {
            risk: "low",
            alerts: 1,
            analyzedAt: "2025-06-01T00:00:00Z",
          },
        },
      },
    });

    const result = await getSkill("lint-skill");

    // Should succeed
    expect("skill" in result).toBe(true);
    if (!("skill" in result)) {
      throw new Error("Expected skill response");
    }

    const detail = result.skill;
    expect(detail.origin).toBe("skillssh");
    expect(detail.id).toBe("lint-skill");

    // Verify audit data is attached
    if (detail.origin === "skillssh") {
      expect(detail.audit).toBeDefined();
      expect(detail.audit!.ath).toEqual({
        risk: "safe",
        score: 100,
        analyzedAt: "2025-06-01T00:00:00Z",
      });
      expect(detail.audit!.socket).toEqual({
        risk: "low",
        alerts: 1,
        analyzedAt: "2025-06-01T00:00:00Z",
      });
    }

    // Verify the real audit fetch targeted the install-meta source repo and
    // the registry slug's last segment.
    const auditCall = http.lastCall("GET");
    expect(auditCall).toBeDefined();
    expect(auditCall!.url).toContain("add-skill.vercel.sh/audit");
    expect(auditCall!.url).toContain("source=acme%2Ftools");
    expect(auditCall!.url).toContain("skills=lint");
  });

  test("returns detail without audit data when the audit fetch fails", async () => {
    const http = mockHttp();
    seedManagedSkill("my-tool", {
      origin: "skillssh",
      slug: "org/repo/my-tool",
      sourceRepo: "org/repo",
    });
    // The real fetchSkillAudits throws on a non-2xx; the handler treats
    // audit failure as non-fatal.
    http.on("GET", "add-skill.vercel.sh/audit", {
      status: 500,
    });

    const result = await getSkill("my-tool");

    // Should still succeed — audit failure is non-fatal
    expect("skill" in result).toBe(true);
    if (!("skill" in result)) {
      throw new Error("Expected skill response");
    }

    const detail = result.skill;
    expect(detail.origin).toBe("skillssh");
    expect(detail.id).toBe("my-tool");

    // Audit data should not be present
    if (detail.origin === "skillssh") {
      expect(detail.audit).toBeUndefined();
    }

    // The audit fetch was still attempted (and failed)
    expect(http.callCount("GET")).toBe(1);
  });

  test("attributes a plugin-resident skill to its owning plugin on the detail response", async () => {
    // GIVEN a skill shipped inside a real plugin directory (package.json
    // manifest + skills/<id>/SKILL.md), discovered by the real loader
    seedPluginWithSkill("caveman", "caveman");

    // WHEN we fetch its detail
    const result = await getSkill("caveman");

    // THEN it resolves to the cadet origin (plugin skills are mapped to
    // bundled/cadet for older clients) while preserving plugin attribution
    // on the owner descriptor the real loader attached
    expect("skill" in result).toBe(true);
    if (!("skill" in result)) {
      throw new Error("Expected skill response");
    }

    const detail = result.skill;
    expect(detail.origin).toBe("cadet");
    expect(detail.id).toBe("caveman");
    // AND the owner identifies the plugin so detail consumers can attribute it
    if (detail.origin === "cadet") {
      expect(detail.owner).toEqual({ kind: "plugin", id: "caveman" });
    }
  });
});

describe("getSkill — assistant-memory conversation lineage", () => {
  test("includes sourceConversationId when install-meta records it", async () => {
    // GIVEN a retrospective-authored skill whose real install-meta.json
    // carries lineage
    seedManagedSkill("triage-inbox", {
      origin: "custom",
      author: "assistant",
      sourceConversationId: "conv-123",
      installedAt: "2026-01-01T00:00:00Z",
    });

    const result = await getSkill("triage-inbox");

    expect("skill" in result).toBe(true);
    if (!("skill" in result)) {
      throw new Error("Expected skill response");
    }

    const detail = result.skill;
    expect(detail.origin).toBe("assistant-memory");
    if (detail.origin === "assistant-memory") {
      expect(detail.sourceConversationId).toBe("conv-123");
    }
  });

  test("omits sourceConversationId when install-meta has none", async () => {
    // GIVEN a retrospective-authored skill without recorded lineage
    seedManagedSkill("triage-inbox", {
      origin: "custom",
      author: "assistant",
      installedAt: "2026-01-01T00:00:00Z",
    });

    const result = await getSkill("triage-inbox");

    expect("skill" in result).toBe(true);
    if (!("skill" in result)) {
      throw new Error("Expected skill response");
    }

    const detail = result.skill;
    expect(detail.origin).toBe("assistant-memory");
    expect("sourceConversationId" in detail).toBe(false);
  });

  test("never exposes lineage on non-assistant-memory origins", async () => {
    // GIVEN a user-installed custom skill that (unexpectedly) carries a
    // sourceConversationId in install-meta
    seedManagedSkill("triage-inbox", {
      origin: "custom",
      sourceConversationId: "conv-123",
      installedAt: "2026-01-01T00:00:00Z",
    });

    const result = await getSkill("triage-inbox");

    expect("skill" in result).toBe(true);
    if (!("skill" in result)) {
      throw new Error("Expected skill response");
    }

    const detail = result.skill;
    expect(detail.origin).toBe("custom");
    expect("sourceConversationId" in detail).toBe(false);
  });
});
