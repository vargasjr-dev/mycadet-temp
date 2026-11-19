import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { CES_SOCKET_DIR_DEFAULT } from "@mycadet/ces-client/socket-path";

/**
 * The assistant container mounts the shared CES socket volume first, so the
 * empty volume takes this directory's mode. CES runs as a non-root user and
 * must be able to create its socket there.
 */
describe("assistant Dockerfile CES socket dir", () => {
  test("makes the CES socket dir writable for the non-root CES user", () => {
    const dockerfile = readFileSync(
      join(import.meta.dir, "../../Dockerfile"),
      "utf8",
    );

    expect(dockerfile).toContain(
      `mkdir -p ${CES_SOCKET_DIR_DEFAULT} && chmod 777 ${CES_SOCKET_DIR_DEFAULT}`,
    );
  });
});
