import path from "node:path";
import { z } from "zod";
import { mkdir, rm } from "node:fs/promises";

const root = path.resolve(import.meta.dirname, "..");
const output = path.join(root, "dist/package");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

for (const [entry, filename, client] of [
  ["src/index.ts", "index.js", true],
  ["src/assistant/resolution-contract.ts", "contracts.js", false],
] as const) {
  const result = await Bun.build({
    entrypoints: [path.join(root, entry)],
    target: "browser",
    format: "esm",
    external: ["react", "react/*", "zod"],
    minify: true,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    jsx: { runtime: "automatic", development: false },
  });
  if (!result.success) {
    throw new AggregateError(result.logs, "App package build failed.");
  }
  const code = await result.outputs[0].text();
  await Bun.write(
    path.join(output, filename),
    client ? `"use client";\n${code}` : code,
  );
}
const types = Bun.spawn(
  [
    "node",
    Bun.resolveSync("typescript/bin/tsc", root),
    "-p",
    "tsconfig.package.json",
  ],
  {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
    windowsHide: true,
  },
);
if ((await types.exited) !== 0) {
  throw new Error("App package declaration build failed.");
}
const parsed = z
  .object({ version: z.string(), dependencies: z.object({ zod: z.string() }) })
  .safeParse(await Bun.file(path.join(root, "package.json")).json());
if (!parsed.success) {
  throw new Error("Invalid app package metadata.");
}
const source = parsed.data;
await Bun.write(
  path.join(output, "package.json"),
  JSON.stringify(
    {
      name: "@mycadet/app",
      version: source.version,
      license: "MIT",
      type: "module",
      sideEffects: false,
      exports: {
        ".": { types: "./types/index.d.ts", default: "./index.js" },
        "./contracts": {
          types: "./types/assistant/resolution-contract.d.ts",
          default: "./contracts.js",
        },
      },
      peerDependencies: { react: ">=19.0.0" },
      dependencies: { zod: source.dependencies.zod },
      files: ["index.js", "contracts.js", "types"],
    },
    null,
    2,
  ) + "\n",
);
console.log("Built @mycadet/app in dist/package.");
