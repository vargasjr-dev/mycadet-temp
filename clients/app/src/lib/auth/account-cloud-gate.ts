export type AccountCloudGate = "pending" | "disabled" | "full";

/** Account login can establish a platform session regardless of assistant hosting. */
export function accountCloudGate({
  sessionStatus,
}: {
  sessionStatus: "initializing" | "authenticated" | "unauthenticated";
}): AccountCloudGate {
  if (sessionStatus === "authenticated") return "full";
  return sessionStatus === "initializing" ? "pending" : "disabled";
}
