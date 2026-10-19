import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  APP_RENDERER_BASE_PROD,
  RENDERER_BASE_PROD,
  getAppDevRendererBase,
  getDevRendererBase,
  getRendererRootUrl,
} from "./app-config";

const ORIGINAL_DEV_URL = process.env.CADET_DEV_URL;
const ORIGINAL_APP_DEV_URL = process.env.CADET_APP_DEV_URL;

beforeEach(() => {
  delete process.env.CADET_DEV_URL;
  delete process.env.CADET_APP_DEV_URL;
});

afterEach(() => {
  if (ORIGINAL_DEV_URL === undefined) {
    delete process.env.CADET_DEV_URL;
  } else {
    process.env.CADET_DEV_URL = ORIGINAL_DEV_URL;
  }
  if (ORIGINAL_APP_DEV_URL === undefined) {
    delete process.env.CADET_APP_DEV_URL;
  } else {
    process.env.CADET_APP_DEV_URL = ORIGINAL_APP_DEV_URL;
  }
});

describe("getRendererRootUrl — the main window renders the app shell", () => {
  test("packaged builds load the slashless app-shell prod base", () => {
    expect(getRendererRootUrl(true)).toBe(APP_RENDERER_BASE_PROD);
  });

  test("dev loads the app-shell Vite fallback (root-based bundle) with a trailing slash", () => {
    expect(getRendererRootUrl(false)).toBe("http://localhost:3001/");
  });

  test("dev appends exactly one trailing slash to CADET_APP_DEV_URL", () => {
    process.env.CADET_APP_DEV_URL = "http://localhost:3011/app";
    expect(getRendererRootUrl(false)).toBe("http://localhost:3011/app/");
  });

  test("dev collapses a CADET_APP_DEV_URL that already carries a trailing slash", () => {
    process.env.CADET_APP_DEV_URL = "http://localhost:3011/app/";
    expect(getRendererRootUrl(false)).toBe("http://localhost:3011/app/");
  });
});

describe("auxiliary-window web base — unchanged by the app-shell flip", () => {
  test("packaged aux windows keep the /assistant web mount", () => {
    expect(RENDERER_BASE_PROD).toBe("app://mycadet.ai/assistant");
  });

  test("dev aux windows keep honoring CADET_DEV_URL", () => {
    process.env.CADET_DEV_URL = "http://localhost:3000/assistant";
    expect(getDevRendererBase()).toBe("http://localhost:3000/assistant");
  });

  test("the app-shell dev base never reads CADET_DEV_URL", () => {
    process.env.CADET_DEV_URL = "http://localhost:3000/assistant";
    expect(getAppDevRendererBase()).toBe("http://localhost:3001");
  });
});
