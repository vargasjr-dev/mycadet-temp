/**
 * Seed real apps into the workspace app store for tests that exercise code
 * reading `apps/app-store.js` — the store's on-disk format is
 * `<appsDir>/<dirName>.json` (metadata) + `<appsDir>/<dirName>/index.html`
 * (definition body), so tests write that shape directly instead of mocking
 * the module. `createApp` mints a random id; seeding here pins the id the
 * test asserts on.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { slugify } from "../../apps/app-store.js";
import { getDataDir } from "../../util/platform.js";

export function seedApp(
  app: Partial<Omit<AppDefinitionFixture, "id">> & { id: string },
): AppDefinitionFixture {
  const appsDir = join(getDataDir(), "apps");
  const dirName = app.dirName ?? slugify(app.name ?? app.id);
  mkdirSync(join(appsDir, dirName), { recursive: true });

  const record = {
    id: app.id,
    name: app.name ?? app.id,
    description: app.description,
    schemaJson: app.schemaJson ?? "{}",
    createdAt: app.createdAt ?? Date.now(),
    updatedAt: app.updatedAt ?? Date.now(),
    formatVersion: 2,
    dirName,
    ...(app.conversationIds ? { conversationIds: app.conversationIds } : {}),
    ...(app.inheritedConversationIds
      ? { inheritedConversationIds: app.inheritedConversationIds }
      : {}),
  };
  writeFileSync(
    join(appsDir, `${dirName}.json`),
    JSON.stringify(record, null, 2),
  );
  writeFileSync(
    join(appsDir, dirName, "index.html"),
    app.htmlDefinition ?? "<html></html>",
  );
  if (app.preview !== undefined) {
    writeFileSync(join(appsDir, `${dirName}.preview`), app.preview);
  }
  return { ...record, htmlDefinition: app.htmlDefinition ?? "<html></html>" };
}

export interface AppDefinitionFixture {
  id: string;
  name: string;
  description?: string;
  preview?: string;
  schemaJson: string;
  htmlDefinition: string;
  createdAt: number;
  updatedAt: number;
  formatVersion?: number;
  dirName?: string;
  conversationIds?: string[];
  inheritedConversationIds?: string[];
}
