import { afterEach, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistRootSigningKey } from "../lib/root-signing-key.js";
const directories: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "root-signing-key-"));
  directories.push(root);
  return root;
}
afterEach(() => {
  for (const root of directories.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});
test("persists the raw key privately so offline capture retains installation identity", () => {
  const root = fixture();
  persistRootSigningKey(root, "07".repeat(32));
  const file = join(root, "gateway-security", "actor-token-signing-key");
  expect(readFileSync(file)).toEqual(Buffer.alloc(32, 7));
  if (process.platform !== "win32") {
    expect(statSync(file).mode & 0o777).toBe(0o600);
  }
});
test("replaces a key file link without changing its target", () => {
  const root = fixture();
  persistRootSigningKey(root, "07".repeat(32));
  const target = join(root, "other");
  writeFileSync(target, "unchanged");
  const file = join(root, "gateway-security", "actor-token-signing-key");
  rmSync(file);
  symlinkSync(target, file);
  persistRootSigningKey(root, "09".repeat(32));
  expect(readFileSync(target, "utf8")).toBe("unchanged");
  expect(readFileSync(file)).toEqual(Buffer.alloc(32, 9));
});
test("rejects invalid key data before writing service state", () => {
  const root = fixture();
  expect(() => persistRootSigningKey(root, "bad")).toThrow(
    "Invalid gateway signing key",
  );
});
