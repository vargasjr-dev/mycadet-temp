import { isObjectRecord } from "../../util/object.js";

/** Verify and retain the original object before inspecting its fields. */
export function requireObjectRecord(value: unknown): Record<string, unknown> {
  if (!isObjectRecord(value)) {
    throw new TypeError("Expected an object");
  }
  return value;
}
