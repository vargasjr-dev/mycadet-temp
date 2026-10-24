import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const ResourcesSchema = z.object({
  instanceDir: z.string().min(1),
});

export class SigningKeyContinuityError extends Error {
  constructor(
    public readonly code: "missing" | "invalid" | "unreadable" | "conflict",
  ) {
    super(
      `Cannot resume authentication: signing key ${code}. Preserve the existing authentication state and restore its original key; no replacement key was generated.`,
    );
    this.name = "SigningKeyContinuityError";
  }
}

/** Resolve existing identity material. This operation never creates or rotates a key. */
export function resolveExistingLocalSigningKey(
  resources: unknown,
  stateRoot?: string,
): string {
  const parsed = ResourcesSchema.safeParse(resources);
  if (!parsed.success) {
    throw new SigningKeyContinuityError("invalid");
  }
  const { instanceDir } = parsed.data;
  // The key lives in the assistant's own storage (the gateway-security file
  // the containers persist); the deprecated workspace file is a read-only
  // migration source and can be stale after an explicit identity repair.
  const candidates: Buffer[] = [];
  const root = stateRoot ?? instanceDir;
  // Both files live inside the assistant's own storage, scoped to this
  // instance rather than the user's home.
  const keyPaths = [
    join(root, "gateway-security", "actor-token-signing-key"),
    join(root, "workspace", "deprecated", "actor-token-signing-key"),
  ];
  for (const keyPath of keyPaths) {
    let raw: Buffer;
    try {
      raw = readFileSync(keyPath);
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        continue;
      }
      throw new SigningKeyContinuityError("unreadable");
    }
    if (raw.length !== 32) {
      throw new SigningKeyContinuityError("invalid");
    }
    candidates.push(raw);
  }
  const key = candidates[0];
  if (!key) {
    throw new SigningKeyContinuityError("missing");
  }
  if (candidates.some((candidate) => !timingSafeEqual(candidate, key))) {
    throw new SigningKeyContinuityError("conflict");
  }
  return key.toString("hex");
}
