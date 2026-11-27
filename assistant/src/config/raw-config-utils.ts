import { isPlainObject } from "../util/object.js";
/**
 * Safely set a nested field on a raw config object's `services` map.
 *
 * Ensures the `services` and service-level objects exist before writing,
 * so callers don't need to guard against undefined intermediate keys.
 *
 * Example: `setServiceField(raw, "image-generation", "provider", "cadet")`
 * produces `raw.services["image-generation"].mode = "managed"`.
 */
export function setServiceField(
  raw: Record<string, unknown>,
  service: string,
  field: string,
  value: unknown,
): void {
  const services = isPlainObject(raw.services) ? raw.services : {};
  const existing = services[service];
  const svc: Record<string, unknown> = isPlainObject(existing) ? existing : {};
  svc[field] = value;
  services[service] = svc;
  raw.services = services;
}

/**
 * Safely set a nested field on a raw config object's `memory.embeddings` map.
 *
 * Ensures the `memory` and `embeddings` objects exist before writing,
 * so callers don't need to guard against undefined intermediate keys.
 *
 * Example: `setMemoryEmbeddingField(raw, "provider", "openai")`
 * produces `raw.memory.embeddings.provider = "openai"`.
 */
export function setMemoryEmbeddingField(
  raw: Record<string, unknown>,
  field: string,
  value: unknown,
): void {
  const memory = isPlainObject(raw.memory) ? raw.memory : {};
  const existing = memory.embeddings;
  const embeddings: Record<string, unknown> = isPlainObject(existing)
    ? existing
    : {};
  embeddings[field] = value;
  memory.embeddings = embeddings;
  raw.memory = memory;
}

/**
 * Safely delete a nested field from a raw config object's `memory.embeddings`
 * map, allowing Zod schema defaults to take effect on the next config reload.
 */
export function deleteMemoryEmbeddingField(
  raw: Record<string, unknown>,
  field: string,
): void {
  const memory = raw.memory;
  if (!isPlainObject(memory)) {
    return;
  }
  const existing = memory.embeddings;
  if (!isPlainObject(existing)) {
    return;
  }
  const embeddings = existing;
  delete embeddings[field];
}
