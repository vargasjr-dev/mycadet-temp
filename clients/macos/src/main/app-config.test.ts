import { describe, expect, test } from "bun:test";

import { APP_RENDERER_BASE_PROD, RENDERER_BASE_PROD } from "./app-config";

describe("renderer bases — the same app:// origins in dev and packaged builds", () => {
  test("the main window loads the slashless app-shell root", () => {
    expect(APP_RENDERER_BASE_PROD).toBe("app://mycadet.ai");
  });

  test("auxiliary windows keep the /assistant web mount on the same origin", () => {
    expect(RENDERER_BASE_PROD).toBe("app://mycadet.ai/assistant");
  });
});
