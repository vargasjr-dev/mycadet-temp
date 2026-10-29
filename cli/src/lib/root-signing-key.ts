import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** Persist gateway identity in the service root without following an existing file link. */
export function persistRootSigningKey(root: string, key: string): void {
  if (!/^[a-f0-9]{64}$/i.test(key)) {
    throw new Error("Invalid gateway signing key.");
  }
  const directory = join(root, "gateway-security");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!lstatSync(directory).isDirectory()) {
    throw new Error("Gateway security root must be a directory.");
  }
  const temporary = join(directory, `.signing-key-${randomUUID()}`);
  const target = join(directory, "actor-token-signing-key");
  try {
    writeFileSync(temporary, Buffer.from(key, "hex"), {
      mode: 0o600,
      flag: "wx",
    });
    // A directory squatting the key path is corruption the repair replaces.
    if (existsSync(target) && lstatSync(target).isDirectory()) {
      rmSync(target, { recursive: true });
    }
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}
