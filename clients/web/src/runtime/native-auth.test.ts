import { describe, expect, mock, test } from "bun:test";

let nativePlatform = false;

mock.module("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => nativePlatform,
    getPlatform: () => "web",
  },
  registerPlugin: (name: string) => (name === "NativeAuth" ? {} : {}),
}));

const { isNativePlatform } = await import("./native-auth");

describe("isNativePlatform", () => {
  test("false on the web", () => {
    nativePlatform = false;
    expect(isNativePlatform()).toBe(false);
  });

  test("true inside a Capacitor shell", () => {
    nativePlatform = true;
    expect(isNativePlatform()).toBe(true);
  });
});
