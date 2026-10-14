import { afterEach, expect, test } from "bun:test";
import { accountUserSnapshot } from "./account-user-snapshot";
const key = "cadet:auth:userSnapshot";
afterEach(() => localStorage.removeItem(key));
test("legacy cloud snapshots normalize malformed fields and reject local identities", () => {
  localStorage.setItem(
    key,
    JSON.stringify({ id: "cloud", firstName: 1, email: 2, isStaff: "true" }),
  );
  expect(accountUserSnapshot.read()).toMatchObject({
    kind: "platform",
    id: "cloud",
    firstName: "",
    email: null,
    isStaff: false,
  });
  localStorage.setItem(
    key,
    JSON.stringify({ kind: "local", id: "gateway-local" }),
  );
  expect(accountUserSnapshot.read()).toBeNull();
});
test("malformed snapshots fail closed and clearing removes the shared user key", () => {
  for (const raw of ["bad JSON", "null", "[]", "true"]) {
    localStorage.setItem(key, raw);
    expect(accountUserSnapshot.read()).toBeNull();
  }
  accountUserSnapshot.clear();
  expect(localStorage.getItem(key)).toBeNull();
});
