import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { matchOperatorRequest } from "../operations/routes";

let tmpDir: string;
let lockfilePath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cadet-profile-op-"));
  lockfilePath = path.join(tmpDir, "cadet", "lockfile.json");
  process.env.XDG_CONFIG_HOME = tmpDir;
});

afterEach(() => {
  delete process.env.XDG_CONFIG_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const writeLockfile = (data: Record<string, unknown>): void => {
  fs.mkdirSync(path.dirname(lockfilePath), { recursive: true });
  fs.writeFileSync(lockfilePath, JSON.stringify(data));
};

/**
 * Seed a local entry whose gateway database already carries the profile
 * columns and a bound guardian row — the shape a bound assistant's
 * gateway.sqlite has after the gateway pushes the schema.
 */
function seedBoundLocalEntry(profile?: {
  username: string;
  email: string;
}): string {
  const instanceDir = path.join(tmpDir, "instance");
  const securityDir = path.join(instanceDir, "gateway-security");
  fs.mkdirSync(securityDir, { recursive: true });
  const db = new Database(path.join(securityDir, "gateway.sqlite"));
  db.exec(`CREATE TABLE contacts (
    id TEXT PRIMARY KEY, display_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'contact', principal_id TEXT,
    username TEXT, email TEXT, first_name TEXT, last_name TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
  db.prepare(
    "INSERT INTO contacts (id, display_name, role, username, email, created_at, updated_at) " +
      "VALUES (?, ?, 'guardian', ?, ?, ?, ?)",
  ).run(
    "contact-1",
    "The Guardian",
    profile?.username ?? null,
    profile?.email ?? null,
    Date.now(),
    Date.now(),
  );
  db.close();
  writeLockfile({
    assistants: [{ assistantId: "asst-local", cloud: "local", instanceDir }],
    activeAssistant: null,
  });
  return instanceDir;
}

/** A gateway database that predates the profile columns. */
function seedUnmigratedLocalEntry(): string {
  const instanceDir = path.join(tmpDir, "instance-old");
  const securityDir = path.join(instanceDir, "gateway-security");
  fs.mkdirSync(securityDir, { recursive: true });
  const db = new Database(path.join(securityDir, "gateway.sqlite"));
  db.exec(`CREATE TABLE contacts (
    id TEXT PRIMARY KEY, display_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'contact', principal_id TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
  db.close();
  writeLockfile({
    assistants: [
      { assistantId: "asst-old", cloud: "local", instanceDir },
    ],
    activeAssistant: null,
  });
  return instanceDir;
}

describe("the operator profile operation", () => {
  test("GET answers the guardian's contact row as the user's profile", async () => {
    seedBoundLocalEntry({ username: "ada", email: "ada@example.com" });

    const match = matchOperatorRequest("/v1/assistant/user/me/", "GET");
    expect(match).not.toBeNull();
    const res = await match!.route.run({ assistantId: match!.assistantId });
    expect(res?.status).toBe(200);
    expect((await res!.json()) as unknown).toEqual({
      id: "contact-1",
      username: "ada",
      email: "ada@example.com",
      first_name: "",
      last_name: "",
    });
  });

  test("the scoped spelling answers the same row", async () => {
    seedBoundLocalEntry({ username: "ada", email: "" });

    const match = matchOperatorRequest(
      "/v1/assistants/asst-local/user/me/",
      "GET",
    );
    expect(match).not.toBeNull();
    const res = await match!.route.run({ assistantId: match!.assistantId });
    expect((await res!.json()) as unknown).toMatchObject({ username: "ada" });
  });

  test("PATCH writes the guardian's row and answers the new record", async () => {
    seedBoundLocalEntry();

    const match = matchOperatorRequest("/v1/assistant/user/me/", "PATCH");
    const res = await match!.route.run({
      assistantId: match!.assistantId,
      body: new Response(
        JSON.stringify({
          username: "grace",
          email: "grace@example.com",
          first_name: "Grace",
        }),
      ).body,
    });
    expect(res?.status).toBe(200);
    expect((await res!.json()) as unknown).toEqual({
      id: "contact-1",
      username: "grace",
      email: "grace@example.com",
      first_name: "Grace",
      last_name: "",
    });

    // The write landed on the guardian's contact row.
    const db = new Database(
      path.join(tmpDir, "instance", "gateway-security", "gateway.sqlite"),
    );
    const row = db
      .prepare(
        "SELECT username, email, first_name FROM contacts WHERE role = 'guardian'",
      )
      .get() as { username: string; email: string; first_name: string };
    db.close();
    expect(row).toEqual({
      username: "grace",
      email: "grace@example.com",
      first_name: "Grace",
    });
  });

  test("PATCH rejects a bad handle with the canonical DRF field error", async () => {
    seedBoundLocalEntry();

    const match = matchOperatorRequest("/v1/assistant/user/me/", "PATCH");
    const res = await match!.route.run({
      assistantId: match!.assistantId,
      body: new Response(JSON.stringify({ username: "12345" })).body,
    });
    expect(res?.status).toBe(400);
    const body = (await res!.json()) as {
      username: Array<{ code: string; string: string }>;
    };
    expect(body.username[0]!.code).toBe("all_digits");
    expect(body.username[0]!.string).toContain("all digits");
  });

  test("availability is a local format check", async () => {
    seedBoundLocalEntry();

    const ok = await matchOperatorRequest(
      "/v1/assistant/user/username-available/",
      "GET",
    )!.route.run({
      assistantId: "asst-local",
      path: "/v1/assistant/user/username-available/?username=grace",
    });
    expect((await ok!.json()) as unknown).toEqual({
      available: true,
      code: null,
      message: null,
    });

    const bad = await matchOperatorRequest(
      "/v1/assistant/user/username-available/",
      "GET",
    )!.route.run({
      assistantId: "asst-local",
      path: "/v1/assistant/user/username-available/?username=ab",
    });
    expect((await bad!.json()) as unknown).toEqual({
      available: false,
      code: "too_short",
      message: "Must be at least 3 characters.",
    });
  });

  test("an unbound assistant answers an empty profile shell", async () => {
    // A local entry whose gateway database has no guardian row yet — the
    // binding flow creates it; the profile reads as an empty shell.
    const instanceDir = path.join(tmpDir, "instance-unbound");
    const securityDir = path.join(instanceDir, "gateway-security");
    fs.mkdirSync(securityDir, { recursive: true });
    const db = new Database(path.join(securityDir, "gateway.sqlite"));
    db.exec(`CREATE TABLE contacts (
      id TEXT PRIMARY KEY, display_name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'contact', principal_id TEXT,
      username TEXT, email TEXT, first_name TEXT, last_name TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
    db.close();
    writeLockfile({
      assistants: [{ assistantId: "asst-unbound", cloud: "local", instanceDir }],
      activeAssistant: null,
    });

    const match = matchOperatorRequest("/v1/assistant/user/me/", "GET");
    const res = await match!.route.run({ assistantId: match!.assistantId });
    expect(res?.status).toBe(200);
    expect((await res!.json()) as unknown).toEqual({
      id: "",
      username: "",
      email: "",
      first_name: "",
      last_name: "",
    });
  });

  test("a gateway database without the profile columns answers 503", async () => {
    seedUnmigratedLocalEntry();

    const match = matchOperatorRequest("/v1/assistant/user/me/", "GET");
    const res = await match!.route.run({ assistantId: match!.assistantId });
    expect(res?.status).toBe(503);
    expect(((await res!.json()) as { detail: string }).detail).toContain(
      "restart",
    );
  });

  test("non-local entries pass through to the pre-existing chain", async () => {
    writeLockfile({
      assistants: [{ assistantId: "asst-docker", cloud: "docker" }],
      activeAssistant: null,
    });

    const match = matchOperatorRequest("/v1/assistant/user/me/", "GET");
    expect(
      await match!.route.run({ assistantId: match!.assistantId }),
    ).toBeNull();
  });
});
