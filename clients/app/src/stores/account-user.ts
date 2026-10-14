import type { z } from "zod";
import type { AccountUserSchema } from "@app/lib/auth/auth-response";
import type { AccountUser } from "@app/stores/auth-state";

export function accountUser(
  raw: z.infer<typeof AccountUserSchema>,
): AccountUser {
  return {
    kind: "cloud",
    id: raw.id ?? raw.email ?? raw.username ?? null,
    username: raw.username ?? null,
    email: raw.email ?? null,
    isStaff: raw.is_staff ?? false,
    firstName: raw.first_name ?? "",
    lastName: raw.last_name ?? "",
  };
}
