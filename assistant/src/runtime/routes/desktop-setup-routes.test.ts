import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";

import { desktopDependencies } from "../../desktop/desktop-dependencies.js";
import { ROUTES } from "./desktop-setup-routes.js";
import { NotFoundError } from "./errors.js";

const originalContainerized = process.env.IS_CONTAINERIZED;
const originalPlatform = process.env.IS_CLOUD;
const status = spyOn(desktopDependencies, "getStatus");

afterAll(() => {
  status.mockRestore();
});

beforeEach(() => {
  process.env.IS_CONTAINERIZED = "true";
  process.env.IS_CLOUD = "true";
  status.mockReturnValue({ state: "ready" });
});

afterEach(() => {
  if (originalContainerized === undefined) {
    delete process.env.IS_CONTAINERIZED;
  } else {
    process.env.IS_CONTAINERIZED = originalContainerized;
  }
  if (originalPlatform === undefined) {
    delete process.env.IS_CLOUD;
  } else {
    process.env.IS_CLOUD = originalPlatform;
  }
  status.mockClear();
});

describe("desktop setup route feature gate", () => {
  for (const route of ROUTES) {
    test(`${route.method} refuses non-containerized assistants`, () => {
      process.env.IS_CONTAINERIZED = "false";
      expect(() => route.handler({})).toThrow(NotFoundError);
      expect(status).not.toHaveBeenCalled();
    });

    test(`${route.method} rejects self-hosted Docker assistants without inspecting dependencies`, () => {
      process.env.IS_CLOUD = "false";
      expect(() => route.handler({})).toThrow(NotFoundError);
      expect(status).not.toHaveBeenCalled();
    });

    test(`${route.method} serves setup for enabled platform containers`, () => {
      expect(route.handler({})).toEqual({
        state: "ready",
        automationActive: false,
      });
      expect(status).toHaveBeenCalledTimes(1);
    });
  }
});
