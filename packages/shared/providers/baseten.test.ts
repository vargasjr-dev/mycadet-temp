import { afterEach, describe, expect, test } from "bun:test";

import { BASETEN_API_KEY_ENV, runBaseten } from "./baseten";

describe("runBaseten", () => {
  test("throws the install message when the CLI is absent from PATH", () => {
    const savedPath = process.env.PATH;
    process.env.PATH = "";
    try {
      expect(() => runBaseten(["sandbox", "list"], "nope")).toThrow(
        /Baseten CLI was not found on PATH/,
      );
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
    }
  });

  test("throws with the failing command on a non-zero exit", () => {
    expect(() => runBaseten(["--version-not-a-flag"], "flag probe")).toThrow(
      /flag probe: baseten --version-not-a-flag exited with/,
    );
  });
});

describe("BASETEN_API_KEY_ENV", () => {
  const saved = process.env[BASETEN_API_KEY_ENV];
  afterEach(() => {
    if (saved === undefined) delete process.env[BASETEN_API_KEY_ENV];
    else process.env[BASETEN_API_KEY_ENV] = saved;
  });

  test("the key contract points at the vaulted credential", () => {
    process.env[BASETEN_API_KEY_ENV] = "";
    // The scripted consumers check this before invoking the CLI; the name
    // must stay stable — it is what `assistant credentials` vaults under
    // baseten:api_key.
    expect(BASETEN_API_KEY_ENV).toBe("BASETEN_API_KEY");
    expect(process.env[BASETEN_API_KEY_ENV]).toBe("");
  });
});
