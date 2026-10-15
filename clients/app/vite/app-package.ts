import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import type { Plugin } from "vite";
import source from "../package.json";

export const packageDependencies = {
  zod: source.dependencies.zod,
  i18next: source.dependencies.i18next,
  "react-i18next": source.dependencies["react-i18next"],
  "i18next-icu": source.dependencies["i18next-icu"],
};

const root = path.resolve(import.meta.dirname, "..");

export function appPackage(): Plugin {
  return {
    name: "app-package",
    async closeBundle() {
      const output = path.join(root, "dist/package");
      const types = spawnSync(
        "node",
        [
          createRequire(import.meta.url).resolve("typescript/bin/tsc"),
          "-p",
          path.join(root, "tsconfig.package.json"),
        ],
        { cwd: root, stdio: "inherit", windowsHide: true },
      );
      if (types.error || types.status !== 0) {
        throw types.error ?? new Error("App declaration build failed.");
      }
      const declarations = path.join(output, "types");
      for (const file of await readdir(declarations, { recursive: true })) {
        if (!file.endsWith(".d.ts")) {
          continue;
        }
        const filename = path.join(declarations, file);
        const code = await readFile(filename, "utf8");
        await writeFile(
          filename,
          code.replace(
            /(["'])@app\/([^"']+)\1/g,
            (_match, quote: string, target: string) => {
              let relative = path
                .relative(
                  path.dirname(filename),
                  path.join(declarations, target),
                )
                .replaceAll(path.sep, "/");
              if (!relative.startsWith(".")) {
                relative = `./${relative}`;
              }
              return `${quote}${relative}${quote}`;
            },
          ),
        );
      }
      // Catalog types reference their JSON modules.
      for (const file of await readdir(path.join(root, "src/i18n/locales"), {
        recursive: true,
      })) {
        if (file.endsWith(".json")) {
          const target = path.join(declarations, "i18n/locales", file);
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(
            target,
            await readFile(path.join(root, "src/i18n/locales", file)),
          );
        }
      }
      await writeFile(
        path.join(output, "package.json"),
        JSON.stringify(
          {
            name: source.name,
            version: source.version,
            license: "MIT",
            type: "module",
            sideEffects: false,
            exports: Object.fromEntries(
              Object.entries(source.exports).map(([entry, conditions]) => [
                entry,
                Object.fromEntries(
                  Object.entries(conditions).map(([condition, target]) => [
                    condition,
                    target.replace("./dist/package/", "./"),
                  ]),
                ),
              ]),
            ),
            peerDependencies: { react: ">=19.0.0" },
            dependencies: packageDependencies,
            files: ["**/*.js", "types"],
          },
          null,
          2,
        ) + "\n",
      );
    },
  };
}
