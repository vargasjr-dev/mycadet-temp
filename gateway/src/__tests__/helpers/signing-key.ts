import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getSigningKeyPath } from "../../auth/token-service.js";

/**
 * Deterministic signing key for tests: writes the key FILE the gateway
 * reads (`GATEWAY_SECURITY_DIR/actor-token-signing-key`). Call before
 * `initSigningKey()`. Uses the caller's `GATEWAY_SECURITY_DIR` when one is
 * already set, otherwise mints a throwaway temp dir and points the env var
 * at it. Returns the security dir in effect.
 */
export function setTestSigningKey(): string {
  let dir = process.env["GATEWAY_SECURITY_DIR"];
  if (!dir) {
    dir = mkdtempSync(join(tmpdir(), "gateway-signing-key-"));
    process.env["GATEWAY_SECURITY_DIR"] = dir;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    getSigningKeyPath(),
    // Exactly 32 bytes — the same key material the old env-var fixture held.
    Buffer.from("test-signing-key-0123456789abcde"),
  );
  return dir;
}
