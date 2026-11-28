import { z } from "zod";

const manifest = z
  .object({
    dependencies: z.record(z.string(), z.string()).optional(),
  })
  .parse(await Bun.file(new URL("../package.json", import.meta.url)).json());

const workspaceDependencies = Object.entries(manifest.dependencies ?? {})
  .filter(([, version]) => version.startsWith("workspace:"))
  .map(([name]) => name)
  .sort();

for (const dependency of workspaceDependencies) {
  const resolvedPath = Bun.resolveSync(dependency, import.meta.dir);
  console.log(`${dependency}: ${resolvedPath}`);
}

console.log(`Resolved ${workspaceDependencies.length} workspace dependencies.`);
