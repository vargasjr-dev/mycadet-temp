import { z } from "zod";
import type { AccountUser } from "@app/stores/auth-state";
const KEY = "cadet:account:userSnapshot";
const Schema = z.object({
  kind: z.literal("cloud"),
  id: z.string().nullable().catch(null),
  username: z.string().nullable().catch(null),
  email: z.string().nullable().catch(null),
  isStaff: z.boolean().catch(false),
  firstName: z.string().catch(""),
  lastName: z.string().catch(""),
});
export const accountUserSnapshot = {
  read(): AccountUser | null {
    try {
      const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? "null");
      const parsed = Schema.safeParse(raw);
      return parsed.success ? { ...parsed.data, kind: "cloud" } : null;
    } catch {
      return null;
    }
  },
  write(user: AccountUser): void {
    if (user.kind !== "cloud") return;
    try {
      localStorage.setItem(KEY, JSON.stringify(user));
    } catch {
      /* Storage unavailable. */
    }
  },
  clear(): void {
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* Storage unavailable. */
    }
  },
};
