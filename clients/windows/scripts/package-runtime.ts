import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { resolveBuildCommitSha } from "./build-metadata";
import { installPinnedBun } from "./bun-release";

const windowsDir = path.resolve(import.meta.dir, "..");
const repoRoot = path.resolve(windowsDir, "..", "..");
const outputDir = path.join(windowsDir, "resources", "cli-runtime");
const releaseChannel = process.env.CADET_ENVIRONMENT || "local";
const targetArch = process.env.ELECTRON_TARGET_ARCH ?? process.arch;
if (targetArch !== "x64" && targetArch !== "arm64") {
  throw new Error(`Unsupported Windows runtime architecture: ${targetArch}`);
}
if (targetArch !== process.arch) {
  throw new Error(`${targetArch} runtime packaging requires a native runner.`);
}

const calculateRuntimeBuildId = (runtimeDir: string): string => {
  const hash = createHash("sha256");
  const visit = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      const relative = path
        .relative(runtimeDir, absolute)
        .replaceAll("\\", "/");
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        hash.update(relative);
        hash.update("\0link\0");
        hash.update(readlinkSync(absolute));
        hash.update("\0");
        continue;
      }
      if (stat.isDirectory()) {
        visit(absolute);
        continue;
      }
      hash.update(relative);
      hash.update("\0");
      hash.update(readFileSync(absolute));
      hash.update("\0");
    }
  };
  visit(runtimeDir);
  return hash.digest("hex");
};
const readPackageVersion = async (packageDir: string): Promise<string> => {
  const manifest = (await Bun.file(
    path.join(repoRoot, packageDir, "package.json"),
  ).json()) as { version?: unknown };
  if (typeof manifest.version !== "string" || !manifest.version.trim()) {
    throw new Error(`${packageDir}/package.json has no valid version.`);
  }
  return manifest.version;
};
const appVersion = await readPackageVersion("clients/windows");
const cliVersion = await readPackageVersion("cli");
const assistantVersion = await readPackageVersion("assistant");
const commitSha = resolveBuildCommitSha();
const bunVersion = (
  await Bun.file(path.join(repoRoot, ".tool-versions")).text()
).match(/^bun\s+(\S+)$/m)?.[1];

if (!bunVersion) {
  throw new Error("The pinned Bun version is missing from .tool-versions.");
}
if (process.platform !== "win32") {
  throw new Error("The Windows CLI runtime must be packaged on Windows.");
}
const currentBun = spawnSync(process.execPath, ["--version"], {
  encoding: "utf8",
  windowsHide: true,
});
if (currentBun.status !== 0 || currentBun.stdout.trim() !== bunVersion) {
  throw new Error(`Packaging requires Bun ${bunVersion}.`);
}

rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });

// Copies only git-tracked files so gitignored residue (skill node_modules
// can run to hundreds of MB on a dev checkout) never ships in the runtime.
const copyTrackedFiles = (source: string, destination: string): void => {
  const listing = spawnSync(
    "git",
    ["-C", repoRoot, "ls-files", "-z", "--", source],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true },
  );
  if (listing.status !== 0) {
    throw new Error(
      `git ls-files failed for ${source} (exit ${listing.status}).`,
    );
  }
  const files = listing.stdout.split("\0").filter(Boolean);
  if (files.length === 0) {
    throw new Error(`No tracked files found under ${source}.`);
  }
  for (const file of files) {
    const target = path.join(destination, path.relative(source, file));
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.join(repoRoot, file), target);
  }
};

// The runtime ships SOURCE, not compiled binaries: bun.exe (pinned below)
// executes the tracked TypeScript of every product package directly. Running
// from source makes module resolution file-relative — imports resolve from
// the source tree's own node_modules chain regardless of the launch CWD —
// and keeps bun's lazy imports lazy (the same tradeoff the mac app made when
// it dropped bun compilation). Workspace imports (@mycadet/*) resolve via the
// install below linking the copied workspace packages into node_modules.
const runtimeWorkspaces = [
  "assistant",
  "assistant/src/api",
  "cli",
  "credential-executor",
  "gateway",
  "packages/*",
] as const;
writeFileSync(
  path.join(outputDir, "package.json"),
  `${JSON.stringify(
    {
      name: "cadet-runtime",
      private: true,
      type: "module",
      workspaces: runtimeWorkspaces,
    },
    null,
    2,
  )}\n`,
);
const runtimeSourceDirs = [
  "assistant",
  "cli",
  "credential-executor",
  "gateway",
  "packages",
] as const;
for (const dir of runtimeSourceDirs) {
  copyTrackedFiles(dir, path.join(outputDir, dir));
}
if (existsSync(path.join(repoRoot, "bunfig.toml"))) {
  copyFileSync(
    path.join(repoRoot, "bunfig.toml"),
    path.join(outputDir, "bunfig.toml"),
  );
}

const runtimeInstall = spawnSync(
  process.execPath,
  ["install", "--production", "--ignore-scripts"],
  { cwd: outputDir, stdio: "inherit", windowsHide: true },
);
if (runtimeInstall.status !== 0) {
  throw new Error(
    `Failed to install the runtime dependency graph (exit ${runtimeInstall.status}).`,
  );
}

// Entry-point shims. Everything the runtime launches goes through bun.exe:
// spawn sites either reference these paths directly or derive them from the
// running bun (dirname(process.execPath) is the runtime root).
const bunEntry = (entry: string): string =>
  `@echo off\r\n"%~dp0bun.exe" "%~dp0${entry.replaceAll("/", "\\")}" %*\r\n`;
writeFileSync(
  path.join(outputDir, "assistant.cmd"),
  bunEntry("assistant/src/windows-compiled-entry.ts"),
);

for (const [source, name] of [
  ["assistant/src/prompts/templates", "templates"],
  ["assistant/src/config/bundled-skills", "bundled-skills"],
  ["assistant/src/runtime/routes/brain-graph", "brain-graph"],
  ["assistant/src/plugins/defaults", "default-plugins"],
  ["clients/windows/resources/web-dist", "web-dist"],
] as const) {
  cpSync(path.join(repoRoot, source), path.join(outputDir, name), {
    recursive: true,
  });
}
for (const [specifier, name] of [
  ["web-tree-sitter/web-tree-sitter.wasm", "web-tree-sitter.wasm"],
  ["tree-sitter-bash/tree-sitter-bash.wasm", "tree-sitter-bash.wasm"],
] as const) {
  copyFileSync(
    Bun.resolveSync(specifier, path.join(repoRoot, "gateway")),
    path.join(outputDir, name),
  );
}
copyTrackedFiles("skills", path.join(outputDir, "first-party-skills"));
const pluginApiShim = spawnSync(
  process.execPath,
  [
    path.join(repoRoot, "assistant", "scripts", "write-plugin-api-shim.ts"),
    outputDir,
  ],
  {
    cwd: repoRoot,
    stdio: "inherit",
    windowsHide: true,
  },
);
if (pluginApiShim.status !== 0) {
  throw new Error(
    `Failed to package the plugin API shim (exit ${pluginApiShim.status}).`,
  );
}
mkdirSync(path.join(outputDir, "scripts"), { recursive: true });
copyFileSync(
  path.join(repoRoot, "clients", "windows", "scripts", "uninstall-cli.ts"),
  path.join(outputDir, "scripts", "uninstall-cli.ts"),
);
writeFileSync(path.join(outputDir, "cadet.cmd"), bunEntry("cli/src/index.ts"));

const bunSource = await installPinnedBun({
  arch: targetArch,
  cacheDir: path.join(windowsDir, "out", "bun-cache"),
  destination: path.join(outputDir, "bun.exe"),
  hostExecutable: process.execPath,
  version: bunVersion,
});
console.log(`Bundled Bun ${bunVersion} (${targetArch}) from ${bunSource}.`);

// Smoke the shipped source through the shipped bun before declaring victory.
const assistantVersionCheck = spawnSync(
  path.join(outputDir, "bun.exe"),
  ["assistant/src/windows-compiled-entry.ts", "--version"],
  {
    cwd: outputDir,
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
  },
);
if (
  assistantVersionCheck.status !== 0 ||
  assistantVersionCheck.stdout.trim() !== assistantVersion
) {
  const diagnostics = [
    `exit ${assistantVersionCheck.status ?? "not started"}`,
    assistantVersionCheck.error
      ? `spawn error: ${assistantVersionCheck.error.message}`
      : null,
    assistantVersionCheck.stderr.trim()
      ? `stderr: ${assistantVersionCheck.stderr.trim()}`
      : null,
  ]
    .filter((detail): detail is string => detail !== null)
    .join("; ");
  throw new Error(
    `Packaged assistant version check failed: expected ${assistantVersion}, got ${assistantVersionCheck.stdout.trim() || "no output"} (${diagnostics}).`,
  );
}
const cliVersionCheck = spawnSync(
  path.join(outputDir, "bun.exe"),
  ["cli/src/index.ts", "--version"],
  { cwd: outputDir, encoding: "utf8", windowsHide: true, timeout: 120_000 },
);
const expectedCliVersion = `@mycadet/cli v${cliVersion}`;
if (
  cliVersionCheck.status !== 0 ||
  cliVersionCheck.stdout.trim() !== expectedCliVersion
) {
  const diagnostics = [
    `exit ${cliVersionCheck.status ?? "not started"}`,
    cliVersionCheck.error
      ? `spawn error: ${cliVersionCheck.error.message}`
      : null,
    cliVersionCheck.stderr.trim()
      ? `stderr: ${cliVersionCheck.stderr.trim()}`
      : null,
  ]
    .filter((detail): detail is string => detail !== null)
    .join("; ");
  throw new Error(
    `Packaged CLI version check failed: expected ${expectedCliVersion}, got ${cliVersionCheck.stdout.trim() || "no output"} (${diagnostics}).`,
  );
}

const runtimeBuildId = calculateRuntimeBuildId(outputDir);
await Bun.write(
  path.join(outputDir, "runtime.json"),
  `${JSON.stringify({ version: appVersion, bunVersion, runtimeBuildId, releaseChannel, architecture: targetArch, commitSha })}\n`,
);
