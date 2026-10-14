export type AccountCloudGate = "pending" | "disabled" | "gated" | "full";

/** Account login can establish a platform session regardless of assistant hosting. */
export function accountCloudGate({
  session,
  local,
  cloudDisabled,
}: {
  session: "unknown" | "absent" | "present";
  local: boolean;
  cloudDisabled: boolean;
}): AccountCloudGate {
  if (local && cloudDisabled) return "gated";
  if (session === "present") return "full";
  return session === "unknown" ? "pending" : "disabled";
}
