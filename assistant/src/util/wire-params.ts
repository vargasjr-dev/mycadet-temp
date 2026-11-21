/**
 * Wire-shaped unknowns (route params, token-endpoint bodies, third-party JSON)
 * read through zod with lenient fallbacks: a field that is absent or the wrong
 * shape reads as `undefined` instead of throwing, so a single sloppy field
 * cannot take down a request that would otherwise succeed.
 *
 * These are deliberately generic probes. Reaching for them repeatedly on the
 * same wire object is a sign the object deserves its own domain schema —
 * prefer that long-term; these are for genuinely one-off reads.
 */

import { z } from "zod";

export const stringParam = (v: unknown): string | undefined =>
  z.string().optional().catch(undefined).parse(v);

/** Like stringParam, but a literal JSON null passes through — a null that
 * means "explicitly clear this field" is distinct from an absent one. */
export const nullableStringParam = (v: unknown): string | null | undefined =>
  z.string().nullable().optional().catch(undefined).parse(v);

export const numberParam = (v: unknown): number | undefined =>
  z.number().optional().catch(undefined).parse(v);

export const booleanParam = (v: unknown): boolean | undefined =>
  z.boolean().optional().catch(undefined).parse(v);

export const recordParam = (v: unknown): Record<string, unknown> | undefined =>
  z.record(z.string(), z.unknown()).optional().catch(undefined).parse(v);
