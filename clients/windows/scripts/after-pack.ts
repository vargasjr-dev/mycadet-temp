import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { CLI_RUNTIME_ENTRIES } from "../src/main/cli-installer";
import { argValue } from "./cli-args";

/**
 * Enumerates every packaged binary that must be signed before release:
 * the app executable, the CLI runtime, the native helper, the preview
 * handler COM DLL, and the NSIS installer. The manifest is the input for
 * later signature verification; a missing required binary fails the pack.
 */

const windowsDir = path.resolve(import.meta.dir, "..");
const SIGNABLE_EXTENSIONS = new Set([".exe", ".dll", ".node"]);

// Only bun.exe is a signable binary in the runtime — everything else ships
// as source executed by bun. The native helper and preview handler stay
// compiled: they are Windows-native components, not product TS.
export const requiredPackageBinaries = (arch: string): string[] => [
  "resources/cli-runtime/bun.exe",
  `resources/native-helper/${arch}/Cadet.WindowsHelper.exe`,
  "resources/preview-handler/Cadet.PreviewHandler.dll",
];

export const requiredPackageEntries = (arch: string): string[] => [
  ...CLI_RUNTIME_ENTRIES.map((entry) => `resources/cli-runtime/${entry}`),
  `resources/native-helper/${arch}/Cadet.WindowsHelper.exe`,
  "resources/preview-handler/Cadet.PreviewHandler.dll",
];

interface ManifestEntry {
  path: string;
  sha256: string;
  sizeBytes: number;
}

export function collectSignableFiles(root: string, dir = root): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSignableFiles(root, absolute));
    } else if (
      SIGNABLE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
    ) {
      files.push(path.relative(root, absolute).replaceAll(path.sep, "/"));
    }
  }
  return files.sort();
}

const describeFile = (absolute: string, relative: string): ManifestEntry => {
  const contents = readFileSync(absolute);
  return {
    path: relative,
    sha256: createHash("sha256").update(contents).digest("hex"),
    sizeBytes: contents.length,
  };
};

const main = (): void => {
  const arch = argValue("--arch");
  if (arch !== "x64" && arch !== "arm64") {
    throw new Error(`--arch must be x64 or arm64, got ${arch}`);
  }
  const manifestPath = path.join(
    windowsDir,
    "dist",
    `signing-manifest-${arch}.json`,
  );

  const installer = argValue("--installer");
  if (installer) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      installers: ManifestEntry[];
    };
    const entry = describeFile(installer, path.basename(installer));
    manifest.installers = [
      ...manifest.installers.filter((it) => it.path !== entry.path),
      entry,
    ];
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    return;
  }

  const appOutDir = argValue("--app-out-dir");
  if (!appOutDir) {
    throw new Error("--app-out-dir or --installer is required");
  }
  const missingEntries = requiredPackageEntries(arch).filter(
    (required) => !existsSync(path.join(appOutDir, required)),
  );
  if (missingEntries.length > 0) {
    throw new Error(
      `Packaged app is missing required entries: ${missingEntries.join(", ")}`,
    );
  }
  const files = collectSignableFiles(appOutDir);
  const missing = requiredPackageBinaries(arch).filter(
    (required) => !files.includes(required),
  );
  if (missing.length > 0) {
    throw new Error(`Packaged app is missing binaries: ${missing.join(", ")}`);
  }
  if (!files.some((file) => !file.includes("/") && file.endsWith(".exe"))) {
    throw new Error("Packaged app has no root executable");
  }
  const manifest = {
    arch,
    files: files.map((file) => describeFile(path.join(appOutDir, file), file)),
    installers: [] as ManifestEntry[],
  };
  mkdirSync(path.dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(
    `Enumerated ${manifest.files.length} signable files into ${manifestPath}`,
  );
};

if (import.meta.main) {
  main();
}
