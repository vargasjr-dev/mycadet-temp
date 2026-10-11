/**
 * Handler-level tests for `getSkillFileContent` — zero-leak.
 *
 * Covers:
 *   - Installed skill, valid path → returns file content (text + binary).
 *   - Installed skill, traversal path → 400 "Invalid path".
 *   - Installed skill, missing file → 404 "File not found".
 *   - Uninstalled cadet catalog skill → cadet provider returns content.
 *   - Uninstalled skills.sh skill → skills.sh provider returns content.
 *   - Uninstalled clawhub skill → clawhub provider returns content.
 *   - Skill not found anywhere → 404.
 *   - Hidden / SKIP_DIRS path segments → rejected with 400 before touching
 *     either the installed-skill disk read or the provider chain fallback.
 *
 * Zero-leak: the REAL catalog loader resolves skills seeded into the
 * workspace skills dir, the REAL path sanitizer validates every path (the
 * former mock carried an inline copy that could drift), and the REAL
 * provider chain runs — the only fakes are the HTTP transport
 * (requests-mock, restored automatically per test) and the clawhub CLI
 * subprocess (a PATH-shimmed `npx` that emits canned JSON while recording
 * its argv). The former ghost-install test (resolver lists a skill whose
 * directory is missing) is gone: through the real loader a resolved
 * skill's directory always exists at resolution time — the handler's
 * `existsSync` branch is defense-in-depth for mid-request unmount races
 * that a deterministic test cannot reach.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { setAllFlagsOnForTesting } from "./feature-flag-test-helpers.js";
import { setConfig } from "./helpers/set-config.js";
import { mockHttp } from "./requests-mock.js";

// Real env: the real getCloudBaseUrl() reads config.cloud.baseUrl — point it
// at a host mockHttp matches by path substring, so the platform-facing
// provider fetches flow through the real env → URL → fetch chain.
setConfig("cloud", { baseUrl: "https://test-cloud.mycadet.ai" });

import {
  _resetFileProvidersForTest,
  getSkillFileContent,
} from "../daemon/handlers/skills.js";
import { getCatalog, invalidateCatalogCache } from "../skills/catalog-cache.js";
import { getWorkspaceSkillsDir } from "../util/layout.js";

// ---------------------------------------------------------------------------
// clawhub CLI subprocess shim — real spawn, canned stdout
// ---------------------------------------------------------------------------

// clawhub-files drives the real `clawhub` CLI through `npx`. The shim is a
// real executable earlier on PATH that records its argv and emits canned
// JSON, so the spawn → stdout-parse → content contract runs for real.
const shimDir = join(tmpdir(), "skills-content-npx-shim");
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
// first, exactly how production warms it before a content read).
function catalogBody(ids: string[]): { skills: unknown[] } {
  return {
    skills: ids.map((id) => ({
      id,
      name: id,
      description: `${id} catalog skill`,
    })),
  };
}

beforeEach(() => {
  setAllFlagsOnForTesting();
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
// Installed-skill path (real loader → real disk reads)
// ---------------------------------------------------------------------------

describe("getSkillFileContent — installed skill", () => {
  test("returns text file content for a valid path", async () => {
    seedWorkspaceSkill("my-skill");

    const result = await getSkillFileContent("my-skill", "SKILL.md");
    expect("error" in result).toBe(false);
    if ("error" in result) {
      return;
    }
    expect(result.path).toBe("SKILL.md");
    expect(result.name).toBe("SKILL.md");
    expect(result.isBinary).toBe(false);
    expect(result.content).toContain("# my-skill");
  });

  test("returns content=null for binary files", async () => {
    seedWorkspaceSkill("my-skill", {
      "img.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    });

    const result = await getSkillFileContent("my-skill", "img.png");
    expect("error" in result).toBe(false);
    if ("error" in result) {
      return;
    }
    expect(result.isBinary).toBe(true);
    expect(result.content).toBeNull();
    expect(result.name).toBe("img.png");
  });

  test("rejects traversal paths with 400 Invalid path", async () => {
    seedWorkspaceSkill("my-skill");

    for (const bad of ["../secrets", "..", "/etc/passwd", "./../escape"]) {
      const result = await getSkillFileContent("my-skill", bad);
      expect("error" in result).toBe(true);
      if (!("error" in result)) {
        continue;
      }
      expect(result.status).toBe(400);
      expect(result.error).toBe("Invalid path");
    }
  });

  test("rejects paths containing null bytes with 400", async () => {
    seedWorkspaceSkill("my-skill");

    const result = await getSkillFileContent("my-skill", "SKILL.md\0.png");
    expect("error" in result).toBe(true);
    if (!("error" in result)) {
      return;
    }
    expect(result.status).toBe(400);
  });

  test("returns 404 for a missing file inside an installed skill", async () => {
    seedWorkspaceSkill("my-skill");

    const result = await getSkillFileContent("my-skill", "ghost.txt");
    expect("error" in result).toBe(true);
    if (!("error" in result)) {
      return;
    }
    expect(result.status).toBe(404);
    expect(result.error).toBe("File not found");
  });
});

// ---------------------------------------------------------------------------
// Provider chain fallback — uninstalled skill content (real providers over
// the mocked HTTP transport)
// ---------------------------------------------------------------------------

describe("getSkillFileContent — uninstalled skill (provider chain)", () => {
  test("cadet provider returns the platform content payload", async () => {
    const http = mockHttp();
    http.on("GET", "/v1/skills/", {
      status: 200,
      body: catalogBody(["remote-skill"]),
    });
    http.on("GET", "/v1/skills/remote-skill/files/content/", {
      status: 200,
      body: {
        path: "SKILL.md",
        name: "SKILL.md",
        size: 14,
        mime_type: "text/markdown",
        is_binary: false,
        content: "# hello world\n",
      },
    });
    // Warm the real catalog cache the same way production does: the list
    // path runs before the content read.
    await getCatalog();

    const result = await getSkillFileContent("remote-skill", "SKILL.md");
    expect("error" in result).toBe(false);
    if ("error" in result) {
      return;
    }
    expect(result.path).toBe("SKILL.md");
    expect(result.name).toBe("SKILL.md");
    expect(result.mimeType).toBe("text/markdown");
    expect(result.isBinary).toBe(false);
    expect(result.content).toBe("# hello world\n");
    // The content fetch carried the sanitized path as its query.
    expect(http.lastCall("GET")?.url).toContain(
      "/v1/skills/remote-skill/files/content/?path=SKILL.md",
    );
  });

  test("returns 404 when the clawhub CLI yields no content for a claimed slug", async () => {
    // The real clawhub canHandle claims every valid slug; with an empty
    // inspect payload the claimed read yields "File not found" (claimed but
    // file absent), not "Skill not found".
    const result = await getSkillFileContent("ghost-skill", "SKILL.md");
    expect("error" in result).toBe(true);
    if (!("error" in result)) {
      return;
    }
    expect(result.status).toBe(404);
    expect(result.error).toBe("File not found");
  });

  test("skills.sh content fallback walks the GitHub API chain", async () => {
    const http = mockHttp();
    // 1. Dir probe (registered first — the entry URL contains this path).
    http.on(
      "GET",
      "/repos/skillssh-owner/skillssh-repo/contents/skills/my-skill",
      {
        status: 200,
        body: [],
      },
    );
    // 2. Contents entry for the requested file (registered second — newest
    //    match wins, and this URL embeds the probe path).
    http.on(
      "GET",
      "/repos/skillssh-owner/skillssh-repo/contents/skills/my-skill/SKILL.md",
      {
        status: 200,
        body: {
          type: "file",
          size: 20,
          download_url:
            "https://raw.githubusercontent.test/skillssh-owner/skillssh-repo/HEAD/skills/my-skill/SKILL.md",
        },
      },
    );
    // 3. Raw content fetch (string body passes through verbatim).
    http.on("GET", "raw.githubusercontent.test", {
      status: 200,
      body: "# skillssh content\n",
    });

    const result = await getSkillFileContent(
      "skillssh-owner/skillssh-repo/my-skill",
      "SKILL.md",
    );
    expect("error" in result).toBe(false);
    if ("error" in result) {
      return;
    }
    expect(result.content).toBe("# skillssh content\n");
    expect(result.path).toBe("SKILL.md");
    expect(result.isBinary).toBe(false);
  });

  test("clawhub content fallback parses the CLI subprocess output", async () => {
    // Re-install the shim with a canned inspect payload: the real
    // clawhub-files code spawns it, parses stdout, and returns the content.
    installNpxShim({ skillMdContent: "# clawhub content yo\n" });

    const result = await getSkillFileContent("cool-tool", "SKILL.md");
    expect("error" in result).toBe(false);
    if ("error" in result) {
      return;
    }
    expect(result.content).toBe("# clawhub content yo\n");
    expect(result.path).toBe("SKILL.md");
    // The real CLI argv reached the shim.
    expect(clawhubCalls().some((argv) => argv.includes("inspect"))).toBe(true);
  });

  test("returns 'File not found' when the cadet provider claims the skill but the file is missing", async () => {
    const http = mockHttp();
    http.on("GET", "/v1/skills/", {
      status: 200,
      body: catalogBody(["known-skill"]),
    });
    http.on("GET", "/v1/skills/known-skill/files/content/", {
      status: 404,
    });
    await getCatalog();

    const result = await getSkillFileContent("known-skill", "nonexistent.txt");
    expect("error" in result).toBe(true);
    if (!("error" in result)) {
      return;
    }
    expect(result.status).toBe(404);
    expect(result.error).toBe("File not found");
  });

  test("stop-on-first-match: clawhub is not consulted when cadet claims the skill", async () => {
    const http = mockHttp();
    http.on("GET", "/v1/skills/", {
      status: 200,
      body: catalogBody(["simple-slug"]),
    });
    http.on("GET", "/v1/skills/simple-slug/files/content/", {
      status: 404,
    });
    await getCatalog();

    const result = await getSkillFileContent("simple-slug", "SKILL.md");
    expect("error" in result).toBe(true);
    if (!("error" in result)) {
      return;
    }
    expect(result.error).toBe("File not found");
    // The clawhub CLI never spawned — the cadet claim short-circuits the chain.
    expect(clawhubCalls()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Skill not found anywhere
// ---------------------------------------------------------------------------

describe("getSkillFileContent — skill not found", () => {
  test("returns 404 when no provider canHandle the id", async () => {
    // The real canHandle gates: cadet needs the id in the catalog cache,
    // skills.sh needs ≥3 slash segments, clawhub needs a valid slug. An id
    // failing all three (space → invalid slug) is claimed by nothing.
    const result = await getSkillFileContent("no such skill", "SKILL.md");
    expect("error" in result).toBe(true);
    if (!("error" in result)) {
      return;
    }
    expect(result.status).toBe(404);
    expect(result.error).toBe("Skill not found");
  });
});

// ---------------------------------------------------------------------------
// Hidden / SKIP_DIRS path rejection (real sanitizer, no inline copy)
// ---------------------------------------------------------------------------

describe("getSkillFileContent — hidden / SKIP_DIRS rejection", () => {
  test("rejects dotfile reads from an installed skill with 400 Invalid path", async () => {
    seedWorkspaceSkill("leaky-skill", { ".env": "SECRET=abc\n" });

    const result = await getSkillFileContent("leaky-skill", ".env");
    expect("error" in result).toBe(true);
    if (!("error" in result)) {
      return;
    }
    expect(result.status).toBe(400);
    expect(result.error).toBe("Invalid path");
  });

  test("rejects dotfile reads for an uninstalled skill before any provider read", async () => {
    const result = await getSkillFileContent("catalog-leaky", ".env");
    expect("error" in result).toBe(true);
    if (!("error" in result)) {
      return;
    }
    expect(result.status).toBe(400);
    expect(result.error).toBe("Invalid path");
    // The hidden-segment check must run before the provider chain — the
    // clawhub CLI (the only provider whose canHandle accepts this id) never
    // spawned.
    expect(clawhubCalls()).toEqual([]);
  });

  test("rejects paths whose parent directory is a dotfile segment", async () => {
    seedWorkspaceSkill("my-skill");

    for (const bad of [".git/config", "docs/.hidden/file.md"]) {
      const result = await getSkillFileContent("my-skill", bad);
      expect("error" in result).toBe(true);
      if (!("error" in result)) {
        continue;
      }
      expect(result.status).toBe(400);
      expect(result.error).toBe("Invalid path");
    }
  });

  test("rejects paths inside SKIP_DIRS segments with 400 Invalid path", async () => {
    seedWorkspaceSkill("my-skill");

    for (const bad of [
      "node_modules/foo/index.js",
      "__pycache__/cached.pyc",
      "nested/node_modules/mod/index.js",
    ]) {
      const result = await getSkillFileContent("my-skill", bad);
      expect("error" in result).toBe(true);
      if (!("error" in result)) {
        continue;
      }
      expect(result.status).toBe(400);
      expect(result.error).toBe("Invalid path");
    }
  });

  test("regular SKILL.md still reads successfully (sanity)", async () => {
    seedWorkspaceSkill("healthy-skill");

    const result = await getSkillFileContent("healthy-skill", "SKILL.md");
    expect("error" in result).toBe(false);
    if ("error" in result) {
      return;
    }
    expect(result.content).toContain("# healthy-skill");
    expect(result.name).toBe("SKILL.md");
  });
});
