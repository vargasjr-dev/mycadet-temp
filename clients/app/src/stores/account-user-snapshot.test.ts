import { afterEach, expect, test } from "bun:test";
import { accountUserSnapshot } from "./account-user-snapshot";
const key = "cadet:account:userSnapshot";
const webKey = "cadet:auth:userSnapshot";
afterEach(() => {
  localStorage.removeItem(key);
  localStorage.removeItem(webKey);
});
test("cloud snapshots normalize malformed fields and reject local identities", () => {
  localStorage.setItem(
    key,
    JSON.stringify({
      kind: "cloud",
      id: "cloud",
      firstName: 1,
      email: 2,
      isStaff: "true",
    }),
  );
  expect(accountUserSnapshot.read()).toMatchObject({
    kind: "cloud",
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
test("only explicit cloud snapshots restore and round-trip", () => {
  for (const snapshot of [
    { id: "user-123" },
    { kind: "platform", id: "user-123" },
    { kind: "local", id: "gateway-local" },
  ]) {
    localStorage.setItem(key, JSON.stringify(snapshot));
    expect(accountUserSnapshot.read()).toBeNull();
  }
  localStorage.setItem(key, JSON.stringify({ kind: "cloud", id: "user-123" }));
  const user = accountUserSnapshot.read();
  expect(user).toMatchObject({ kind: "cloud", id: "user-123" });
  if (user) {
    accountUserSnapshot.write(user);
    expect(accountUserSnapshot.read()).toEqual(user);
  }
});
test("malformed snapshots fail closed and clearing removes the account user key", () => {
  for (const raw of ["bad JSON", "null", "[]", "true"]) {
    localStorage.setItem(key, raw);
    expect(accountUserSnapshot.read()).toBeNull();
  }
  accountUserSnapshot.clear();
  expect(localStorage.getItem(key)).toBeNull();
});

test("web snapshots cannot restore or overwrite the account snapshot", () => {
  localStorage.setItem(
    webKey,
    JSON.stringify({ kind: "platform", id: "web-user" }),
  );
  expect(accountUserSnapshot.read()).toBeNull();
  localStorage.setItem(
    key,
    JSON.stringify({ kind: "cloud", id: "account-user" }),
  );
  localStorage.setItem(
    webKey,
    JSON.stringify({ kind: "platform", id: "other-web-user" }),
  );
  expect(accountUserSnapshot.read()).toMatchObject({
    kind: "cloud",
    id: "account-user",
  });
});
