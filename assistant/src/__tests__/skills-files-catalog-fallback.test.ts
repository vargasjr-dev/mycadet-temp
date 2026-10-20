/**
 * Tests for `getSkillFiles` provider chain fallback — zero-leak.
 *
 * When a skill id isn't resolvable via `findSkillById` (i.e. not installed
 * locally, not bundled, not a cloud skill), `getSkillFiles` falls back to
 * the provider chain (cadet catalog → skills.sh → clawhub). Each provider
 * is tried in order until one returns data. When a skill IS resolved by
 * `findSkillById` but its on-disk directory is missing, `getSkillFiles`
 * returns a 404 without falling through to the provider chain so the
 * listing and detail responses agree on `isInstalled`.
 *
 * Coverage:
 *   - Uninstalled catalog skill: returns `{ skill: catalog/cadet/available, files }` with `content: null` for every entry.
 *   - Neither installed nor claimed by any provider: returns 404.
 *   - Installed skill: preserves the disk-read behavior with inline `content`.
 *   - `catalogSkillToSlim` mapping: `metadata.cadet["display-name"]` wins over `cs.name`.
 *   - skills.sh-shaped ID not in cadet catalog returns files from skills.sh provider.
 *   - clawhub-shaped ID not in cadet catalog returns files from clawhub provider.
 *   - ID that no provider canHandle returns 404.
 *   - Provider priority: cadet provider is tried before skills.sh/clawhub.
 *
 * Zero-leak: the REAL catalog loader resolves skills seeded into the
 * workspace skills dir, the REAL provider chain runs (cadet catalog +
 * GitHub-API choreography over the requests-mock transport; the clawhub CLI
 * subprocess spawned for real against a PATH-shimmed `npx` that records its
 * argv), and the REAL `catalogSkillToSlim` mapping is asserted instead of a
 * mock's echo. The former ghost-install test (resolver lists a skill whose
 * directory is missing) is gone: through the real loader a resolved
 * skill's directory always exists at resolution time — the handler's
 * `existsSync` branch is defense-in-depth for mid-request unmount races
 * that a deterministic test cannot reach.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { setConfig } from "./helpers/set-config.js";
import { mockHttp } from "./requests-mock.js";

// Real env: the real getCloudBaseUrl() reads config.cloud.baseUrl — point it
// at a host mockHttp matches by path substring, so the platform-facing
// provider fetches flow through the real env → URL → fetch chain.
setConfig("cloud", { baseUrl: "https://test-cloud.mycadet.ai" });

import {
  _resetFileProvidersForTest,
  getSkillFiles,
} from "../daemon/handlers/skills.js";
import { getCatalog, invalidateCatalogCache } from "../skills/catalog-cache.js";
import { getWorkspaceSkillsDir } from "../util/layout.js";

// ---------------------------------------------------------------------------
// clawhub CLI subprocess shim — real spawn, canned stdout
// ---------------------------------------------------------------------------

// clawhub-files drives the real `clawhub` CLI through `npx`. The shim is a
// real executable earlier on PATH that records its argv and emits canned
// JSON, so the spawn → stdout-parse contract runs for real.
const shimDir = join(tmpdir(), "skill-files-npx-shim");
const shimRecord = join(shimDir, "calls.log");
const shimScript = [
  "#!/bin/sh",
  'if [ -n "${FAKE_NPX_RECORD:-}" ]; then',
  '  printf \'%s\\n\' "$*" >> "$FAKE_NPX_RECORD"',
  "fi",
  "printf '%s' \"${FAKE_NPX_RESPONSE:-}\"",
  "exit 0",
].join("\n");

let originalPath: string | undefined;

const clawhubCalls = (): string[] => {
  if (!existsSync(shimRecord)) {
    return [];
  }
  return readFileSync(shimRecord, "utf-8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
};

function installNpxShim(inspectResponse: unknown): void {
  mkdirSync(shimDir, { recursive: true });
  writeFileSync(join(shimDir, "npx"), shimScript, { mode: 0o755 });
  process.env.FAKE_NPX_RESPONSE = JSON.stringify(inspectResponse ?? {});
  process.env.FAKE_NPX_RECORD = shimRecord;
  originalPath = process.env.PATH;
  process.env.PATH = `${shimDir}:${process.env.PATH ?? ""}`;
}

// ---------------------------------------------------------------------------
// Workspace skill seeding — the real loader resolves these
// ---------------------------------------------------------------------------

const seededSkillDirs: string[] = [];

function seedWorkspaceSkill(
  id: string,
  files: Record<string, string | Buffer> = {},
): string {
  const dir = join(getWorkspaceSkillsDir(), id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${id}\ndescription: seeded test skill\n---\n# ${id}\n`,
  );
  for (const [relPath, content] of Object.entries(files)) {
    const abs = join(dir, relPath);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  seededSkillDirs.push(dir);
  return dir;
}

// A catalog listing the given skills — served for the platform catalog fetch
// that warms the real cache (`getCatalog()` mirrors the list path running
// first, exactly how production warms it before a fallback read).
function catalogBody(entries: unknown[]): { skills: unknown[] } {
  return { skills: entries };
}

function catalogEntry(id: string, metadata?: unknown): unknown {
  return {
    id,
    name: id,
    description: `${id} catalog skill`,
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

beforeEach(() => {
  invalidateCatalogCache();
  _resetFileProvidersForTest();
  installNpxShim({});
});

afterEach(() => {
  if (originalPath !== undefined) {
    process.env.PATH = originalPath;
    originalPath = undefined;
  }
  delete process.env.FAKE_NPX_RESPONSE;
  delete process.env.FAKE_NPX_RECORD;
  rmSync(shimDir, { recursive: true, force: true });
  for (const dir of seededSkillDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  seededSkillDirs.length = 0;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getSkillFiles — provider chain fallback", () => {
  test("returns catalog skill with files (content: null) when skill is uninstalled but present in cadet catalog", async () => {
    const http = mockHttp();
    http.on("GET", "/v1/skills/", {
      status: 200,
      body: catalogBody([
        catalogEntry("acme-seo", {
          cadet: { "display-name": "Acme SEO", category: "knowledge" },
        }),
      ]),
    });
    http.on("GET", "/v1/skills/acme-seo/files/", {
      status: 200,
      body: {
        files: [
          { path: "SKILL.md", name: "SKILL.md", size: 42 },
          { path: "assets/logo.png", name: "logo.png", size: 1024 },
        ],
      },
    });
    // Warm the real catalog cache the same way production does: the list
    // path runs before the fallback read.
    await getCatalog();

    const result = await getSkillFiles("acme-seo");

    expect("error" in result).toBe(false);
    if ("error" in result) {
      return;
    }

    // The REAL catalogSkillToSlim mapping produced the slim response.
    expect(result.skill.id).toBe("acme-seo");
    expect(result.skill.name).toBe("Acme SEO");
    expect(result.skill.kind).toBe("catalog");
    expect(result.skill.origin).toBe("cadet");
    expect(result.skill.status).toBe("available");
    expect(result.skill.category).toBe("knowledge");
    expect(result.files).toHaveLength(2);
    for (const entry of result.files) {
      expect(entry.content).toBeNull();
    }
    // Files should be sorted by path via localeCompare
    expect(result.files.map((f) => f.path)).toEqual(
      [...result.files.map((f) => f.path)].sort((a, b) => a.localeCompare(b)),
    );
    expect(new Set(result.files.map((f) => f.path))).toEqual(
      new Set(["SKILL.md", "assets/logo.png"]),
    );
  });

  test("returns 404 when skill is neither installed nor claimed by any provider", async () => {
    // An invalid clawhub slug with fewer than three segments is claimable by
    // no provider: cadet needs the catalog cache, skills.sh needs ≥3 slash
    // segments, clawhub needs a valid slug.
    const result = await getSkillFiles("no such skill");

    expect("error" in result).toBe(true);
    if (!("error" in result)) {
      return;
    }
    expect(result.status).toBe(404);
  });

  test("returns 404 with 'files unavailable' when cadet provider claims the skill but listFiles returns null", async () => {
    const http = mockHttp();
    http.on("GET", "/v1/skills/", {
      status: 200,
      body: catalogBody([catalogEntry("broken-skill")]),
    });
    http.on("GET", "/v1/skills/broken-skill/files/", {
      status: 404,
    });
    await getCatalog();

    const result = await getSkillFiles("broken-skill");

    expect("error" in result).toBe(true);
    if (!("error" in result)) {
      return;
    }
    expect(result.status).toBe(404);
    expect(result.error).toContain("broken-skill");
    expect(result.error).toContain("unavailable");
  });

  test("installed skill returns inline disk content (no provider fallback)", async () => {
    seedWorkspaceSkill("installed-skill", {
      "notes.txt": "Some notes about the skill.",
    });

    const result = await getSkillFiles("installed-skill");

    expect("error" in result).toBe(false);
    if ("error" in result) {
      return;
    }

    expect(result.files).toHaveLength(2);
    const skillMd = result.files.find((f) => f.path === "SKILL.md");
    const notes = result.files.find((f) => f.path === "notes.txt");
    expect(skillMd).toBeDefined();
    expect(notes).toBeDefined();
    expect(skillMd!.content).toContain("# installed-skill");
    expect(notes!.content).toBe("Some notes about the skill.");

    // Sort-by-path behavior (localeCompare order) is preserved.
    expect(result.files.map((f) => f.path)).toEqual(
      [...result.files.map((f) => f.path)].sort((a, b) => a.localeCompare(b)),
    );
  });

  test("catalogSkillToSlim falls back to cs.name when metadata.cadet.display-name is absent", async () => {
    const http = mockHttp();
    http.on("GET", "/v1/skills/", {
      status: 200,
      body: catalogBody([catalogEntry("plain-skill")]),
    });
    http.on("GET", "/v1/skills/plain-skill/files/", {
      status: 200,
      body: { files: [] },
    });
    await getCatalog();

    const result = await getSkillFiles("plain-skill");

    expect("error" in result).toBe(false);
    if ("error" in result) {
      return;
    }
    // Real mapping: no display-name metadata → the raw catalog name wins,
    // and category falls back to "system".
    expect(result.skill.name).toBe("plain-skill");
    expect(result.skill.category).toBe("system");
    expect(result.skill.kind).toBe("catalog");
    expect(result.skill.origin).toBe("cadet");
    expect(result.skill.status).toBe("available");
  });

  test("catalogSkillToSlim prefers metadata.cadet.display-name over cs.name", async () => {
    const http = mockHttp();
    http.on("GET", "/v1/skills/", {
      status: 200,
      body: catalogBody([
        catalogEntry("fancy-skill", {
          cadet: { "display-name": "Pretty Fancy Name" },
        }),
      ]),
    });
    http.on("GET", "/v1/skills/fancy-skill/files/", {
      status: 200,
      body: { files: [] },
    });
    await getCatalog();

    const result = await getSkillFiles("fancy-skill");

    expect("error" in result).toBe(false);
    if ("error" in result) {
      return;
    }
    expect(result.skill.name).toBe("Pretty Fancy Name");
  });

  test("skills.sh-shaped ID not in cadet catalog returns files from skills.sh provider", async () => {
    const http = mockHttp();
    // The real skills.sh chain: dir probe, then the recursive Contents API
    // listing of that directory (same URL — one registration serves both).
    http.on(
      "GET",
      "/repos/skillssh-owner/skillssh-repo/contents/skills/my-skill",
      {
        status: 200,
        body: [
          {
            name: "SKILL.md",
            path: "skills/my-skill/SKILL.md",
            type: "file",
          },
        ],
      },
    );

    const result = await getSkillFiles("skillssh-owner/skillssh-repo/my-skill");

    expect("error" in result).toBe(false);
    if ("error" in result) {
      return;
    }
    expect(result.skill.origin).toBe("skillssh");
    expect(result.files).toHaveLength(1);
    expect(result.files[0].path).toBe("SKILL.md");
    expect(result.files[0].content).toBeNull();
  });

  test("clawhub-shaped ID not in cadet catalog returns files from clawhub provider", async () => {
    // Re-install the shim with a canned inspect payload including a files list.
    installNpxShim({
      skill: {
        slug: "cool-tool",
        displayName: "Cool Tool",
        summary: "A clawhub skill",
      },
      owner: { handle: "someone" },
      stats: { stars: 5, installs: 10 },
      files: [
        { path: "SKILL.md", size: 200 },
        { path: "lib/utils.js", size: 500, contentType: "text/javascript" },
      ],
    });

    const result = await getSkillFiles("cool-tool");

    expect("error" in result).toBe(false);
    if ("error" in result) {
      return;
    }
    // The REAL provider mapped the CLI's inspect output.
    expect(result.skill.origin).toBe("clawhub");
    expect(result.skill.name).toBe("Cool Tool");
    expect(result.files).toHaveLength(2);
    expect(result.files[0].content).toBeNull();
  });

  test("ID that no provider canHandle returns 404", async () => {
    const result = await getSkillFiles("no such skill anywhere");

    expect("error" in result).toBe(true);
    if (!("error" in result)) {
      return;
    }
    expect(result.status).toBe(404);
  });

  test("provider priority — cadet provider is tried before skills.sh and clawhub", async () => {
    const http = mockHttp();
    http.on("GET", "/v1/skills/", {
      status: 200,
      body: catalogBody([
        catalogEntry("contested-skill", {
          cadet: { "display-name": "Cadet Contested" },
        }),
      ]),
    });
    http.on("GET", "/v1/skills/contested-skill/files/", {
      status: 200,
      body: {
        files: [{ path: "SKILL.md", name: "SKILL.md", size: 10 }],
      },
    });
    await getCatalog();

    const result = await getSkillFiles("contested-skill");

    expect("error" in result).toBe(false);
    if ("error" in result) {
      return;
    }
    // Cadet provider should have been used
    expect(result.skill.origin).toBe("cadet");
    expect(result.skill.name).toBe("Cadet Contested");
    // The chain stops on the first match: the clawhub CLI never spawned even
    // though its canHandle claims every valid slug.
    expect(clawhubCalls()).toEqual([]);
  });
});
