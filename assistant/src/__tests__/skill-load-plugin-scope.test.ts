/**
 * Tests that `skill_load` rejects loading a plugin-owned skill whose owning
 * plugin is outside the conversation's effective per-chat plugin set, and lets
 * it through when the plugin is in scope (or when there is no restriction).
 *
 * Fixture skills are real directories under the per-process workspace
 * (`plugins/p`, `plugins/q`, and a managed workspace skill for the
 * always-allowed core child), so the real loader discovers them — no module
 * mocks.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "bun:test";

import { skillLoadTool } from "../tools/skills/load.js";
import { getWorkspaceDir } from "../util/platform.js";

function writeSkill(
  root: string,
  id: string,
  opts: {
    displayName: string;
    description: string;
    body: string;
    includes?: string[];
  },
): void {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  const lines = [
    "---",
    `name: "${id}"`,
    `description: "${opts.description}"`,
    'compatibility: "Designed for Cadet personal assistants"',
    "metadata:",
    "  cadet:",
    `    display-name: "${opts.displayName}"`,
  ];
  if (opts.includes) {
    lines.push("    includes:");
    for (const inc of opts.includes) {
      lines.push(`      - "${inc}"`);
    }
  }
  lines.push("---", "", opts.body, "");
  writeFileSync(join(dir, "SKILL.md"), lines.join("\n"));
}

beforeAll(() => {
  const ws = getWorkspaceDir();

  // Two real plugin packages, p and q, each shipping resident skills.
  for (const pluginId of ["p", "q"]) {
    const pluginDir = join(ws, "plugins", pluginId);
    mkdirSync(join(pluginDir, "skills"), { recursive: true });
    writeFileSync(
      join(pluginDir, "package.json"),
      JSON.stringify({ name: pluginId, version: "1.0.0" }),
    );
  }

  const pSkills = join(ws, "plugins", "p", "skills");
  writeSkill(pSkills, "plug-skill", {
    displayName: "Plugin Skill",
    description: "Owned by plugin p",
    body: "Do the plugin thing.",
  });
  writeSkill(pSkills, "child-in", {
    displayName: "Child In",
    description: "In-scope child owned by plugin p",
    body: "CHILD IN BODY",
  });
  // ── Include-path scope fixture ──────────────────────────────────────
  // An in-scope parent (plugin "p") that includes three children: a managed
  // workspace child (no plugin owner — always allowed), an in-scope plugin
  // child (plugin "p"), and an out-of-scope plugin child (plugin "q", not in
  // the effective set).
  writeSkill(pSkills, "parent-skill", {
    displayName: "Parent Skill",
    description: "In-scope parent including a child per plugin",
    body: "PARENT BODY",
    includes: ["child-core", "child-in", "child-out"],
  });
  writeSkill(join(ws, "plugins", "q", "skills"), "child-out", {
    displayName: "Child Out",
    description: "Out-of-scope child owned by plugin q",
    body: "CHILD OUT BODY",
  });

  // Managed workspace skill: no plugin owner, so the scope gate always
  // admits it (the "bundled/core child" role in the include fixture).
  writeSkill(join(ws, "skills"), "child-core", {
    displayName: "Child Core",
    description: "Workspace child, always allowed",
    body: "CHILD CORE BODY",
  });
});

async function loadWithScope(
  enabledPluginSet: Set<string> | null | undefined,
  selector = "plug-skill",
): Promise<{ content: string; isError: boolean }> {
  const tool = skillLoadTool;
  const result = await tool.execute(
    { skill: selector },
    {
      workingDir: "/tmp",
      conversationId: "conversation-1",
      trustClass: "guardian",
      enabledPluginSet,
    },
  );
  return { content: result.content, isError: result.isError };
}

describe("skill_load — per-chat plugin scope", () => {
  test("rejects a plugin skill whose owner is outside the effective set", async () => {
    const result = await loadWithScope(new Set(["other"]));
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not available in this conversation");
    expect(result.content).toContain("plug-skill");
  });

  test("loads the plugin skill when its owner is in the effective set", async () => {
    const result = await loadWithScope(new Set(["p"]));
    expect(result.content).not.toContain("not available in this conversation");
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Skill: Plugin Skill");
  });

  test("null set (no per-chat restriction) loads the plugin skill", async () => {
    const result = await loadWithScope(null);
    expect(result.content).not.toContain("not available in this conversation");
    expect(result.isError).toBe(false);
  });

  test("absent set (no per-chat restriction) loads the plugin skill", async () => {
    const result = await loadWithScope(undefined);
    expect(result.content).not.toContain("not available in this conversation");
    expect(result.isError).toBe(false);
  });
});

describe("skill_load — per-chat plugin scope on included children", () => {
  test("omits an out-of-scope plugin child's body + marker, keeps in-scope/core children", async () => {
    // Chat scoped to plugin "p". Parent (plugin "p") includes a core child, an
    // in-scope plugin child, and an out-of-scope plugin "q" child.
    const result = await loadWithScope(new Set(["p"]), "parent-skill");

    expect(result.isError).toBe(false);
    expect(result.content).toContain("PARENT BODY");

    // Core and in-scope plugin children: body + loaded-skill marker.
    expect(result.content).toContain("CHILD CORE BODY");
    expect(result.content).toContain('<loaded_skill id="child-core"');
    expect(result.content).toContain("CHILD IN BODY");
    expect(result.content).toContain('<loaded_skill id="child-in"');

    // Out-of-scope plugin "q" child: no body, no marker, not even listed.
    expect(result.content).not.toContain("CHILD OUT BODY");
    expect(result.content).not.toContain("child-out");
  });

  test("with no restriction (null set) the out-of-scope child is included", async () => {
    const result = await loadWithScope(null, "parent-skill");

    expect(result.isError).toBe(false);
    // Without a per-chat restriction every included child is injected.
    expect(result.content).toContain("CHILD OUT BODY");
    expect(result.content).toContain('<loaded_skill id="child-out"');
  });
});
