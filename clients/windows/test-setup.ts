// The shim's mock.module calls live in the package's setup() (Vargas's
// #915 thread 4652393542 — bun keys interception on the executing test's
// module graph, not the call site's package).
import { setup } from "@mycadet/electron-desktop/test-setup";

setup();
