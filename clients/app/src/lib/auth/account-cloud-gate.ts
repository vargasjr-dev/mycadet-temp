export type AccountCloudGate = "pending" | "disabled" | "full";

/** Account login can establish a platform session regardless of assistant hosting. */
export function accountCloudGate({
  session,
}: {
  session: "unknown" | "absent" | "present";
}): AccountCloudGate {
  if (session === "present") return "full";
  return session === "unknown" ? "pending" : "disabled";
}
