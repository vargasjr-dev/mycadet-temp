import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

/**
 * The assistant image copies workspace package sources after `bun install`,
 * and the container smoke step resolves each declared `workspace:*`
 * dependency. A declared dependency that is not COPYed fails the image
 * build with `Cannot find module '@mycadet/<name>'` — the DR134 red.
 */
describe("assistant Dockerfile workspace packages", () => {
  test("copies every workspace dependency into the image", () => {
    const repoRoot = join(import.meta.dir, "../../..");
    const pkg = JSON.parse(
      readFileSync(join(repoRoot, "assistant/package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    const dockerfile = readFileSync(
      join(repoRoot, "assistant/Dockerfile"),
      "utf8",
    );

    const missing: string[] = [];
    for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
      if (version !== "workspace:*") {
        continue;
      }
      if (!name.startsWith("@mycadet/")) {
        missing.push(`${name} (unexpected workspace package)`);
        continue;
      }
      const dir = `packages/${name.slice("@mycadet/".length)}`;
      if (!dockerfile.includes(`COPY ${dir} `)) {
        missing.push(dir);
      }
    }

    expect(missing).toEqual([]);
  });
});
