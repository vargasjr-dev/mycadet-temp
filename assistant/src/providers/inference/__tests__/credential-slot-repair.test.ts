import { beforeEach, describe, expect, test } from "bun:test";

import { useFaultableSecureKeyMap } from "../../../__tests__/helpers/secure-keys.js";

// ── Vault mock (must precede imports) ───────────────────────────────────────

const vaultHandle = useFaultableSecureKeyMap();
const vault = vaultHandle.store;

// ── Real imports (after mocks) ──────────────────────────────────────────────

import { getDb } from "../../../persistence/db-connection.js";
import { initializeDb } from "../../../persistence/db-init.js";
import { providerConnections } from "../../../persistence/schema/inference.js";
import { getConnection } from "../connections.js";
import { repairSharedCredentialSlots } from "../credential-slot-repair.js";

await initializeDb();

const LEGACY = "credential/openai-compatible/api_key";

function seedRow(name: string, credential: string): void {
  const now = Date.now();
  getDb()
    .insert(providerConnections)
    .values({
      name,
      provider: "openai-compatible",
      auth: JSON.stringify({ type: "api_key", credential }),
      baseUrl: `https://${name}.example/v1`,
      models: JSON.stringify([{ id: "model-1" }]),
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

function refOf(name: string): string | undefined {
  const row = getConnection(getDb(), name);
  return row?.auth.type === "api_key" ? row.auth.credential : undefined;
}

beforeEach(() => {
  getDb().delete(providerConnections).run();
  for (const k of Array.from(vault.keys())) {
    vault.delete(k);
  }
  vaultHandle.setAllUnreachable(false);
});

describe("repairSharedCredentialSlots", () => {
  test("repoints sharing rows to per-connection slots and copies the shared value", async () => {
    seedRow("openai-compatible-personal", LEGACY);
    seedRow("openai-compatible-personal-2", LEGACY);
    vault.set(LEGACY, "sk-last-saved");

    await repairSharedCredentialSlots(getDb());

    expect(refOf("openai-compatible-personal")).toBe(
      "credential/openai-compatible-personal/api_key",
    );
    expect(refOf("openai-compatible-personal-2")).toBe(
      "credential/openai-compatible-personal-2/api_key",
    );
    // Behavior-preserving: each new slot holds the value the row resolved
    // through the shared slot.
    expect(vault.get("credential/openai-compatible-personal/api_key")).toBe(
      "sk-last-saved",
    );
    expect(vault.get("credential/openai-compatible-personal-2/api_key")).toBe(
      "sk-last-saved",
    );
  });

  test("an empty shared slot still repoints the refs without writing secrets", async () => {
    seedRow("openai-compatible-personal", LEGACY);

    await repairSharedCredentialSlots(getDb());

    expect(refOf("openai-compatible-personal")).toBe(
      "credential/openai-compatible-personal/api_key",
    );
    expect(vault.size).toBe(0);
  });

  test("defers everything when the vault is unreachable", async () => {
    seedRow("openai-compatible-personal", LEGACY);
    vaultHandle.setAllUnreachable(true);

    await repairSharedCredentialSlots(getDb());

    expect(refOf("openai-compatible-personal")).toBe(LEGACY);
  });

  test("leaves per-connection and custom refs untouched; idempotent", async () => {
    seedRow(
      "openai-compatible-personal",
      "credential/openai-compatible-personal/api_key",
    );
    seedRow("my-endpoint", "credential/shared-team-key/api_key");

    await repairSharedCredentialSlots(getDb());
    await repairSharedCredentialSlots(getDb());

    expect(refOf("openai-compatible-personal")).toBe(
      "credential/openai-compatible-personal/api_key",
    );
    expect(refOf("my-endpoint")).toBe("credential/shared-team-key/api_key");
    expect(vault.size).toBe(0);
  });

  test("does not overwrite a value already present in a per-connection slot", async () => {
    seedRow("openai-compatible-personal", LEGACY);
    vault.set(LEGACY, "sk-shared");
    vault.set(
      "credential/openai-compatible-personal/api_key",
      "sk-already-mine",
    );

    await repairSharedCredentialSlots(getDb());

    expect(vault.get("credential/openai-compatible-personal/api_key")).toBe(
      "sk-already-mine",
    );
    expect(refOf("openai-compatible-personal")).toBe(
      "credential/openai-compatible-personal/api_key",
    );
  });
});
