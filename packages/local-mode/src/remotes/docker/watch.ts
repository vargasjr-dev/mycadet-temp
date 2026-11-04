/**
 * The docker hatch's watch mode: watch the repo's source trees, rebuild the
 * affected service images, and restart their containers on change. Dev
 * machinery — it exists only for `cadet hatch --watch` / `--source`, never
 * for the hatch operation (a serving host has no long-lived repo to watch).
 */

import { existsSync, readdirSync, watch as fsWatch } from "node:fs";
import { join } from "node:path";
import { exec } from "../../exec";
import { dockerResourceNames, removeContainer } from "./retire";
import {
  type ServiceName,
  buildServiceRunArgs,
  resolveAvatarDevicePath,
} from "./statefulset";
import { SERVICE_START_ORDER } from "./wake";

export function collectWatchTargets(repoRoot: string): {
  dirs: string[];
  files: string[];
} {
  const packagesDir = join(repoRoot, "packages");
  const packageRoots = existsSync(packagesDir)
    ? readdirSync(packagesDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(packagesDir, entry.name))
    : [];

  const serviceRoots = [
    join(repoRoot, "assistant"),
    join(repoRoot, "credential-executor"),
    join(repoRoot, "gateway"),
    ...packageRoots,
  ];

  const dirs: string[] = [];
  const files: string[] = [];
  for (const root of serviceRoots) {
    const srcDir = join(root, "src");
    if (existsSync(srcDir)) dirs.push(srcDir);
    for (const name of ["package.json", "Dockerfile"]) {
      const file = join(root, name);
      if (existsSync(file)) files.push(file);
    }
  }
  return { dirs, files };
}

/**
 * Determine which services are affected by a changed file path relative
 * to the repository root.
 */
function affectedServices(
  filePath: string,
  repoRoot: string,
): Set<ServiceName> {
  const rel = filePath.startsWith(repoRoot)
    ? filePath.slice(repoRoot.length + 1)
    : filePath;

  const affected = new Set<ServiceName>();

  if (rel.startsWith("assistant/")) {
    affected.add("assistant");
  }
  if (rel.startsWith("credential-executor/")) {
    affected.add("credential-executor");
  }
  if (rel.startsWith("gateway/")) {
    affected.add("gateway");
  }
  // Shared packages affect both assistant and credential-executor
  if (rel.startsWith("packages/")) {
    affected.add("assistant");
    affected.add("credential-executor");
  }

  return affected;
}

/**
 * Watch for source changes across the assistant, gateway, credential-executor,
 * and packages services — scoped to each service's `src/` tree, `package.json`,
 * and `Dockerfile` (see `collectWatchTargets`). When changes are detected,
 * rebuild the affected images and restart their containers.
 */
export function startFileWatcher(opts: {
  cesServiceToken?: string;
  extraAssistantEnv?: Record<string, string>;
  extraGatewayEnv?: Record<string, string>;
  gatewayPort: number;
  imageTags: Record<ServiceName, string>;
  instanceName: string;
  repoRoot: string;
  res: ReturnType<typeof dockerResourceNames>;
  netnsContainer?: string;
  assistantCaCertPath?: string;
}): () => void {
  const { gatewayPort, imageTags, instanceName, repoRoot, res } = opts;

  const { dirs: watchDirs, files: watchFiles } = collectWatchTargets(repoRoot);

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingServices = new Set<ServiceName>();
  let rebuilding = false;

  const configs = serviceImageConfigs(repoRoot, imageTags);
  const runArgs = buildServiceRunArgs({
    cesServiceToken: opts.cesServiceToken,
    extraAssistantEnv: opts.extraAssistantEnv,
    extraGatewayEnv: opts.extraGatewayEnv,
    gatewayPort,
    imageTags,
    instanceName,
    res,
    avatarDevicePath: resolveAvatarDevicePath(),
    netnsContainer: opts.netnsContainer,
    assistantCaCertPath: opts.assistantCaCertPath,
  });
  const containerForService: Record<ServiceName, string> = {
    assistant: res.assistantContainer,
    "credential-executor": res.cesContainer,
    gateway: res.gatewayContainer,
  };

  async function rebuildAndRestart(): Promise<void> {
    if (rebuilding) return;
    rebuilding = true;

    const services = pendingServices;
    pendingServices = new Set();

    // Gateway and CES share the assistant's network namespace. If the
    // assistant container is removed and recreated, the shared namespace
    // is destroyed and the other two lose connectivity. Cascade the
    // restart to all three services in that case.
    if (services.has("assistant")) {
      services.add("gateway");
      services.add("credential-executor");
    }

    const serviceNames = [...services].join(", ");
    console.log(`\n🔄 Changes detected — rebuilding: ${serviceNames}`);

    try {
      await Promise.all(
        [...services].map(async (service) => {
          console.log(`🔨 Building ${service}...`);
          await buildImage(configs[service]);
          console.log(`✅ ${service} built`);
        }),
      );

      // Restart in dependency order (assistant first) so the network
      // namespace owner is up before dependents try to attach.
      for (const service of SERVICE_START_ORDER) {
        if (!services.has(service)) continue;
        const container = containerForService[service];
        console.log(`🔄 Restarting ${container}...`);
        await removeContainer(container);
        await exec("docker", runArgs[service]());
      }

      console.log("✅ Rebuild complete — watching for changes...\n");
    } catch (err) {
      console.error(
        `❌ Rebuild failed: ${err instanceof Error ? err.message : err}`,
      );
      console.log("   Watching for changes...\n");
    } finally {
      rebuilding = false;
      if (pendingServices.size > 0) {
        rebuildAndRestart();
      }
    }
  }

  const watchers: ReturnType<typeof fsWatch>[] = [];

  function onChange(fullPath: string): void {
    const services = affectedServices(fullPath, repoRoot);
    if (services.size === 0) return;

    for (const s of services) {
      pendingServices.add(s);
    }

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      rebuildAndRestart();
    }, 500);
  }

  for (const dir of watchDirs) {
    const watcher = fsWatch(dir, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      if (filename.includes("node_modules") || filename.includes(".env")) {
        return;
      }
      onChange(join(dir, filename));
    });
    // fs.watch surfaces transient errors (e.g. an unreadable entry) as an
    // `error` event, which would otherwise crash the process. Log and keep
    // the remaining watchers running.
    watcher.on("error", (err) => {
      console.error(
        `⚠️  File watcher error for ${dir}: ${err instanceof Error ? err.message : err}`,
      );
    });
    watchers.push(watcher);
  }

  for (const file of watchFiles) {
    const watcher = fsWatch(file, () => onChange(file));
    watcher.on("error", (err) => {
      console.error(
        `⚠️  File watcher error for ${file}: ${err instanceof Error ? err.message : err}`,
      );
    });
    watchers.push(watcher);
  }

  console.log("👀 Watching for file changes in:");
  console.log("   <service>/src, <service>/package.json, <service>/Dockerfile");
  console.log("   for assistant/, gateway/, credential-executor/, packages/*");
  console.log("");

  return () => {
    for (const watcher of watchers) {
      watcher.close();
    }
    if (debounceTimer) clearTimeout(debounceTimer);
  };
}

interface ServiceImageConfig {
  context: string;
  dockerfile: string;
  tag: string;
}

export async function buildImage(config: ServiceImageConfig): Promise<void> {
  await exec(
    "docker",
    ["build", "-f", config.dockerfile, "-t", config.tag, "."],
    { cwd: config.context },
  );
}

export function serviceImageConfigs(
  repoRoot: string,
  imageTags: Record<ServiceName, string>,
): Record<ServiceName, ServiceImageConfig> {
  return {
    assistant: {
      context: repoRoot,
      dockerfile: "assistant/Dockerfile",
      tag: imageTags.assistant,
    },
    "credential-executor": {
      context: repoRoot,
      dockerfile: "credential-executor/Dockerfile",
      tag: imageTags["credential-executor"],
    },
    gateway: {
      context: repoRoot,
      dockerfile: "gateway/Dockerfile",
      tag: imageTags.gateway,
    },
  };
}
