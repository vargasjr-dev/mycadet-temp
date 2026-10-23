import {
  LockfileAssistantSchema,
  type LocalAssistantResources,
} from "@mycadet/local-mode/contract";

import type { LockfileAssistant } from "../../lib/assistant-config.js";

type EntryOverrides = Partial<Omit<LockfileAssistant, "resources">> & {
  resources?: Partial<LocalAssistantResources>;
};

const BASE_RESOURCES = {
  instanceDir: "/tmp/cadet-test-instance",
  daemonPort: 7801,
  gatewayPort: 7831,
  cesPort: 7790,
  signingKey: "ab".repeat(32),
};

/**
 * The canonical lockfile-entry fixture — one `makeEntry` for every suite.
 * Parses through `LockfileAssistantSchema` so the shape is always the
 * contract's. A `resources` override MERGES onto the base ports instead of
 * replacing them: a partial override that dropped `instanceDir` once broke
 * a drain test.
 */
export function makeEntry(overrides: EntryOverrides = {}): LockfileAssistant {
  const { resources, ...rest } = overrides;
  return LockfileAssistantSchema.parse({
    assistantId: "assistant-1",
    cloud: "local",
    runtimeUrl: "http://127.0.0.1:7831",
    guardianBootstrapSecret: "test-bootstrap-secret",
    ...rest,
    resources: { ...BASE_RESOURCES, ...resources },
  });
}
