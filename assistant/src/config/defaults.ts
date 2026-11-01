import { applyNestedDefaults } from "./loader.js";
import { AssistantConfig } from "./schema.js";

// Single source of truth: Zod schema field-level .default() values.
export const DEFAULT_CONFIG: AssistantConfig = applyNestedDefaults({});
