import {
  buildVBundle as sharedBuild,
  buildExportVBundle as sharedExport,
  streamExportVBundle as sharedStream,
} from "@mycadet/backup/builder";
import type {
  BuildVBundleOptions,
  BuildExportVBundleOptions,
} from "@mycadet/backup/builder";
import { trackDaemonActivity } from "../../daemon/activity-trail.js";
import { getLogger } from "../../util/logger.js";
export * from "@mycadet/backup/builder";
const warn = (context: Record<string, unknown>, message: string) =>
  getLogger("vbundle-builder").warn(context, message);
export function buildVBundle(options: BuildVBundleOptions) {
  return sharedBuild({ ...options, warn });
}
export function buildExportVBundle(options: BuildExportVBundleOptions) {
  return sharedExport({ ...options, warn });
}
export function streamExportVBundle(options: BuildExportVBundleOptions) {
  return trackDaemonActivity({ kind: "vbundle_export" }, () =>
    sharedStream({ ...options, warn }),
  );
}
