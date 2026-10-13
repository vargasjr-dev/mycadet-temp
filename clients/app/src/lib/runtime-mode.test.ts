import { afterAll, expect, test } from "bun:test";
import { isLocalClient } from "@app/lib/runtime-mode";

const original = process.env.VITE_CLOUD_MODE;
afterAll(() => {
  if (original === undefined) delete process.env.VITE_CLOUD_MODE;
  else process.env.VITE_CLOUD_MODE = original;
});

test("runtime mode preserves VITE_CLOUD_MODE values and local default", () => {
  delete process.env.VITE_CLOUD_MODE;
  expect(isLocalClient()).toBe(true);
  for (const value of ["true", "TRUE", "1", "yes"]) {
    process.env.VITE_CLOUD_MODE = value;
    expect(isLocalClient()).toBe(false);
  }
  for (const value of ["", "false", "0", "no"]) {
    process.env.VITE_CLOUD_MODE = value;
    expect(isLocalClient()).toBe(true);
  }
});
