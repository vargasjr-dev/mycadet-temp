import { afterEach, expect, test } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { createAuthorityCookieJar } from "./authority-cookie-jar";

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "authority-jar-"));
  directories.push(dir);
  const file = path.join(dir, "cookies.enc");
  const key = randomBytes(32);
  const encryption = {
    isEncryptionAvailable: () => true,
    encryptString(text: string) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([cipher.update(text), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
    decryptString(data: Buffer) {
      const cipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
      cipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([
        cipher.update(data.subarray(28)),
        cipher.final(),
      ]).toString();
    },
  };
  const options = {
    filePath: () => file,
    encryption,
    warn: (_message: string) => {},
  };
  return { file, options, jar: createAuthorityCookieJar(options) };
}
const expires = () => Date.now() / 1000 + 3600;
test("persists separate authority cookies across restarts without plaintext tokens", async () => {
  const { file, options, jar } = fixture();
  await jar.set("http://127.0.0.1:20102", {
    name: "cadet_web_access",
    value: "first-secret",
    expirationDate: expires(),
  });
  await jar.set("http://127.0.0.1:20103", {
    name: "cadet_web_access",
    value: "second-secret",
    expirationDate: expires(),
  });
  await jar.set("https://cloud.example", {
    name: "sessionid",
    value: "cloud-secret",
    expirationDate: expires(),
  });
  const restarted = createAuthorityCookieJar(options);
  expect((await restarted.get("http://127.0.0.1:20102"))[0]?.value).toBe(
    "first-secret",
  );
  expect((await restarted.get("http://127.0.0.1:20103"))[0]?.value).toBe(
    "second-secret",
  );
  expect((await restarted.get("https://cloud.example"))[0]?.value).toBe(
    "cloud-secret",
  );
  expect(readFileSync(file).includes(Buffer.from("first-secret"))).toBe(false);
  if (process.platform !== "win32")
    expect(statSync(file).mode & 0o777).toBe(0o600);
});
test("honors expiry, deletion, and session-cookie lifetimes", async () => {
  const { jar, options } = fixture();
  await jar.set("http://localhost:1", { name: "a", value: "session" });
  await jar.set("http://localhost:1", {
    name: "b",
    value: "live",
    expirationDate: expires(),
  });
  await jar.set("http://localhost:1", {
    name: "b",
    value: "deleted",
    expirationDate: 0,
  });
  expect((await jar.get("http://localhost:1")).map((c) => c.name)).toEqual([
    "a",
  ]);
  const restarted = createAuthorityCookieJar(options);
  expect(await restarted.get("http://localhost:1")).toEqual([]);
});
test("uses memory only without OS encryption, including Linux basic_text", async () => {
  for (const available of [false, true]) {
    const { file, options } = fixture();
    const jar = createAuthorityCookieJar({
      ...options,
      encryption: {
        ...options.encryption,
        isEncryptionAvailable: () => available,
        getSelectedStorageBackend: () => "basic_text",
      },
    });
    await jar.set("http://localhost:1", {
      name: "a",
      value: "secret",
      expirationDate: expires(),
    });
    expect((await jar.get("http://localhost:1"))[0]?.value).toBe("secret");
    expect(existsSync(file)).toBe(false);
  }
});
test("fails closed on a corrupt encrypted file", async () => {
  const { file, options } = fixture();
  writeFileSync(file, "invalid encrypted data");
  expect(
    await createAuthorityCookieJar(options).get("http://localhost:1"),
  ).toEqual([]);
});
