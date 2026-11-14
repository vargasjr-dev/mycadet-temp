import {
  addAppConversationId,
  appFileExists,
  createApp,
  deleteApp,
  getApp,
  listApps,
  updateApp,
  writeAppFile,
} from "../../../apps/app-store.js";
import type { AppStore } from "../../../tools/apps/executors.js";

/**
 * The real app store, as an explicit {@link AppStore}.
 *
 * The bundled app-builder tools' single injection point. Naming the members
 * (rather than handing over the whole `import * as` namespace) keeps the
 * store surface this skill depends on legible — and the imports statically
 * attributable.
 */
export const bundledAppStore: AppStore = {
  appFileExists,
  createApp,
  deleteApp,
  getApp,
  listApps,
  updateApp,
  writeAppFile,
  addAppConversationId,
};
