import { SystemPermissionKind } from "@mycadet/ipc-contract";
import { SystemPermissionStateItem } from "@mycadet/ipc-contract";
import type { CompanionIntroPermission } from "./use-companion-intro-permission";

export function permissionItem(
  kind: SystemPermissionKind,
  status: SystemPermissionStateItem["status"] = "not-determined",
): SystemPermissionStateItem {
  return {
    kind,
    status,
    canRequest: status === "not-determined",
    canOpenSettings: status !== "granted",
    requiresRestart: false,
  };
}

export function introPermission(
  kind: CompanionIntroPermission["kind"],
  status: SystemPermissionStateItem["status"] = "not-determined",
): CompanionIntroPermission {
  return {
    kind,
    state: { phase: "known", item: permissionItem(kind, status) },
    enable: () => {},
  };
}
