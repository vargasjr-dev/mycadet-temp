import { app, safeStorage } from "electron";
import log from "./app-logger";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { CookieJar } from "@mycadet/local-mode";

type Cookie = Awaited<ReturnType<CookieJar["get"]>>[number];
interface Encryption {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
  getSelectedStorageBackend?(): string;
}
const cookieSchema = z.object({
  name: z.string().min(1),
  value: z.string(),
  path: z.string().optional(),
  secure: z.boolean().optional(),
  httpOnly: z.boolean().optional(),
  sameSite: z
    .enum(["unspecified", "no_restriction", "lax", "strict"])
    .optional(),
  expirationDate: z.number().finite().optional(),
});
const fileSchema = z.object({
  version: z.literal(1),
  origins: z.record(z.string(), z.array(cookieSchema)),
});

/** An authority is a full HTTP(S) origin, including port, rather than a cookie domain. */
function authority(url: string): string {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol))
    throw new Error("Unsupported cookie authority");
  return parsed.origin;
}

export function createAuthorityCookieJar(options: {
  filePath(): string;
  encryption: Encryption;
  warn(message: string): void;
}): CookieJar {
  const origins = new Map<string, Cookie[]>();
  let loaded = false;
  let warned = false;
  const live = (cookie: Cookie) =>
    cookie.expirationDate === undefined ||
    cookie.expirationDate > Date.now() / 1000;
  const canPersist = () =>
    options.encryption.isEncryptionAvailable() &&
    options.encryption.getSelectedStorageBackend?.() !== "basic_text";
  function load() {
    if (loaded) return;
    loaded = true;
    if (!canPersist()) return;
    const file = options.filePath();
    if (!existsSync(file)) return;
    try {
      const data = fileSchema.parse(
        JSON.parse(options.encryption.decryptString(readFileSync(file))),
      );
      for (const [origin, cookies] of Object.entries(data.origins))
        origins.set(authority(origin), cookies.filter(live));
    } catch {
      options.warn(
        "Unable to restore authority cookies; stored credentials were not used",
      );
    }
  }
  function persist() {
    if (!canPersist()) {
      if (!warned)
        options.warn(
          "OS-backed cookie encryption unavailable; cookies remain in memory only",
        );
      warned = true;
      return;
    }
    const file = options.filePath();
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      // Session-only cookies stay in memory.
      const data = {
        version: 1,
        origins: Object.fromEntries(
          [...origins].map(([origin, cookies]) => [
            origin,
            cookies.filter((c) => live(c) && c.expirationDate !== undefined),
          ]),
        ),
      };
      writeFileSync(
        temporary,
        options.encryption.encryptString(JSON.stringify(data)),
        { mode: 0o600, flag: "wx" },
      );
      renameSync(temporary, file);
    } catch {
      options.warn(
        "Unable to persist authority cookies; cookies remain available in memory",
      );
    } finally {
      try {
        rmSync(temporary, { force: true });
      } catch {
        /* Best-effort temporary-file cleanup. */
      }
    }
  }
  return {
    async get(url) {
      load();
      let origin: string;
      try {
        origin = authority(url);
      } catch {
        return [];
      }
      return (origins.get(origin) ?? []).filter(live).map((c) => ({ ...c }));
    },
    async set(url, cookie) {
      load();
      let origin: string;
      try {
        origin = authority(url);
      } catch {
        return;
      }
      const validated = cookieSchema.safeParse(cookie);
      if (!validated.success) {
        options.warn("Invalid authority cookie was not stored");
        return;
      }
      const parsed = validated.data;
      const cookies = (origins.get(origin) ?? []).filter(
        (c) =>
          live(c) &&
          !(c.name === parsed.name && (c.path ?? "/") === (parsed.path ?? "/")),
      );
      if (live(parsed)) cookies.push(parsed);
      origins.set(origin, cookies);
      persist();
    },
  };
}

// Keep the operator seam, but isolate credentials by full origin rather than
// Chromium's port-insensitive domain matching. The path is read after app ready.
export const authorityCookieJar = createAuthorityCookieJar({
  filePath: () => path.join(app.getPath("userData"), "authority-cookies.enc"),
  encryption: {
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    encryptString: (value) => safeStorage.encryptString(value),
    decryptString: (value) => safeStorage.decryptString(value),
    getSelectedStorageBackend: () =>
      process.platform === "linux"
        ? safeStorage.getSelectedStorageBackend()
        : "os_crypt",
  },
  warn: (message) => log.warn(`[protocol-cookies] ${message}`),
});
