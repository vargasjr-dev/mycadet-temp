import { describe, expect, test } from "bun:test";

import { isCadetStaff } from "@/lib/auth/staff";
import type { AuthUser } from "@/stores/auth-store";

function user(overrides: Partial<AuthUser>): AuthUser {
  return {
    kind: "platform",
    id: "user-123",
    username: null,
    email: "user@example.com",
    isStaff: false,
    firstName: "",
    lastName: "",
    ...overrides,
  };
}

describe("isCadetStaff", () => {
  test("accepts the platform staff bit", () => {
    expect(isCadetStaff(user({ isStaff: true }))).toBe(true);
  });

  test("accepts a Cadet address case-insensitively", () => {
    expect(isCadetStaff(user({ email: "alice@" + "VELLUM.AI" }))).toBe(true);
  });

  test("rejects a lookalike domain", () => {
    // Suffix matching includes the "@", so a domain that merely ends in
    // "cadet.ai" does not qualify.
    expect(isCadetStaff(user({ email: "eve@notcadet.ai" }))).toBe(false);
  });

  test("rejects regular users", () => {
    expect(isCadetStaff(user({ email: "user@example.com" }))).toBe(false);
  });

  test("rejects sessions carrying neither signal", () => {
    // Local gateway sessions have no email and no staff bit.
    expect(isCadetStaff(null)).toBe(false);
    expect(isCadetStaff(user({ email: null }))).toBe(false);
  });
});
