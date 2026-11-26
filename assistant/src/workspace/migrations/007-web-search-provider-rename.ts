import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { isPlainObject } from "../../util/object.js";
import type { WorkspaceMigration } from "./types.js";

export const webSearchProviderRenameMigration: WorkspaceMigration = {
  id: "007-web-search-provider-rename",
  description:
    'Rename web-search provider from "anthropic-native" to "inference-provider-native"',
  run(workspaceDir: string): void {
    const configPath = join(workspaceDir, "config.json");
    if (!existsSync(configPath)) {
      return;
    }

    let config: Record<string, unknown>;
    try {
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      if (!isPlainObject(raw)) {
        return;
      }
      config = raw;
    } catch {
      return;
    }

    const services = config.services;
    if (!isPlainObject(services)) {
      return;
    }

    const webSearch = services["web-search"];
    if (!isPlainObject(webSearch)) {
      return;
    }

    const ws = webSearch;
    if (ws.provider !== "anthropic-native") {
      return;
    }

    ws.provider = "inference-provider-native";
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  },
  down(workspaceDir: string): void {
    const configPath = join(workspaceDir, "config.json");
    if (!existsSync(configPath)) {
      return;
    }

    let config: Record<string, unknown>;
    try {
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      if (!isPlainObject(raw)) {
        return;
      }
      config = raw;
    } catch {
      return;
    }

    const services = config.services;
    if (!isPlainObject(services)) {
      return;
    }

    const webSearch = services["web-search"];
    if (!isPlainObject(webSearch)) {
      return;
    }

    const ws = webSearch;
    if (ws.provider !== "inference-provider-native") {
      return;
    }

    ws.provider = "anthropic-native";
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  },
};
