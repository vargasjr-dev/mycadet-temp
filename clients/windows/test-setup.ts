/**
 * The complete `electron` module mock is defined once in the electron
 * package — one surface for the three desktop shells and the package's own
 * suite. bun scopes `mock.module` interception to the package that calls
 * it, so this shim registers the shared factories here, in the shell's own
 * scope; test files import `electronMock` from the package directly.
 */
import { mock } from "bun:test";

import {
  electronLogModuleMock,
  electronModuleMock,
} from "@mycadet/electron-desktop/test-setup";

mock.module("electron", electronModuleMock);
mock.module("electron-log/main", electronLogModuleMock);
