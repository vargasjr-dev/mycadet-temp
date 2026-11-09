/**
 * The user's account profile — routed AND stored on the assistant.
 *
 * Per the cloud-client census, the user's profile is an assistant API the
 * assistant tracks for the user: the record lives in the gateway's own
 * database and these routes answer from it — nothing here dials the
 * platform. The web bundle's profile card edits the user's handle and
 * identity fields through the assistant API it already talks to.
 *
 * Handle rules are enforced locally with the platform's canonical error
 * codes (the same wire shape: DRF field errors on the 400 body), so the
 * web's field-error parser and error-copy map work unchanged. There is no
 * global handle namespace on the assistant — "taken" never fires locally;
 * availability is a pure format/reserved check.
 */

import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { z } from "zod";

import { getGatewayDb } from "../../db/connection.js";
import { userProfile } from "../../db/schema.js";
import { getLogger } from "../../logger.js";

import type { RouteDefinition } from "./types.js";

const log = getLogger("user-profile");

// ---------------------------------------------------------------------------
// Handle rules — the canonical codes the web bundle already has copy for
// ---------------------------------------------------------------------------

export const USERNAME_ERROR_CODES = [
  "too_short",
  "too_long",
  "invalid_chars",
  "leading_underscore",
  "trailing_underscore",
  "leading_hyphen",
  "trailing_hyphen",
  "all_digits",
  "reserved",
  "taken",
] as const;

export type UsernameErrorCode = (typeof USERNAME_ERROR_CODES)[number];

const USERNAME_COPY: Record<UsernameErrorCode, string> = {
  too_short: "Must be at least 3 characters.",
  too_long: "Must be at most 30 characters.",
  invalid_chars:
    "Use only lowercase letters, digits, hyphens, and underscores.",
  leading_underscore: "Cannot start with an underscore.",
  trailing_underscore: "Cannot end with an underscore.",
  leading_hyphen: "Cannot start with a hyphen.",
  trailing_hyphen: "Cannot end with a hyphen.",
  all_digits: "Cannot be all digits.",
  reserved: "This handle is reserved.",
  taken: "This handle is already taken.",
};

/** Check a candidate handle against the assistant's local handle rules. */
export function checkUsernameRule(username: string): UsernameErrorCode | null {
  if (username.length < 3) return "too_short";
  if (username.length > 30) return "too_long";
  if (/[^a-z0-9_-]/.test(username)) return "invalid_chars";
  if (username.startsWith("_")) return "leading_underscore";
  if (username.endsWith("_")) return "trailing_underscore";
  if (username.startsWith("-")) return "leading_hyphen";
  if (username.endsWith("-")) return "trailing_hyphen";
  if (/^[0-9]+$/.test(username)) return "all_digits";
  return null;
}

// ---------------------------------------------------------------------------
// Spec schemas
// ---------------------------------------------------------------------------

export const UserProfileSchema = z.object({
  id: z.string(),
  username: z.string(),
  email: z.string(),
  first_name: z.string(),
  last_name: z.string(),
});

export const UserProfilePatchSchema = z
  .object({
    username: z
      .string()
      .min(1)
      .optional(),
    email: z.string().optional(),
    first_name: z.string().optional(),
    last_name: z.string().optional(),
  })
  .strict();

export const UsernameAvailabilitySchema = z.object({
  available: z.boolean(),
  code: z.enum(USERNAME_ERROR_CODES).nullable(),
  message: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

type UserProfileRow = {
  profileId: string;
  username: string;
  email: string;
  firstName: string;
  lastName: string;
};

function readProfileRow(): UserProfileRow | undefined {
  const row = getGatewayDb()
    .select()
    .from(userProfile)
    .where(eq(userProfile.id, 1))
    .get();
  return row
    ? {
        profileId: row.profileId,
        username: row.username,
        email: row.email,
        firstName: row.firstName,
        lastName: row.lastName,
      }
    : undefined;
}

function writeProfileRow(patch: Partial<UserProfileRow>): UserProfileRow {
  const existing = readProfileRow();
  const next: UserProfileRow = {
    profileId: existing?.profileId ?? randomUUID(),
    username: patch.username ?? existing?.username ?? "",
    email: patch.email ?? existing?.email ?? "",
    firstName: patch.firstName ?? existing?.firstName ?? "",
    lastName: patch.lastName ?? existing?.lastName ?? "",
  };
  getGatewayDb()
    .insert(userProfile)
    .values({
      id: 1,
      profileId: next.profileId,
      username: next.username,
      email: next.email,
      firstName: next.firstName,
      lastName: next.lastName,
      updatedAt: new Date().toISOString(),
    })
    .onConflictDoUpdate({
      target: userProfile.id,
      set: {
        username: next.username,
        email: next.email,
        firstName: next.firstName,
        lastName: next.lastName,
        updatedAt: new Date().toISOString(),
      },
    })
    .run();
  return next;
}

function toApiShape(row: UserProfileRow) {
  return {
    id: row.profileId,
    username: row.username,
    email: row.email,
    first_name: row.firstName,
    last_name: row.lastName,
  };
}

/** DRF field-error body — the wire shape the web's parser already speaks. */
function fieldError(code: UsernameErrorCode): Response {
  return Response.json(
    { username: [{ code, string: USERNAME_COPY[code] }] },
    { status: 400 },
  );
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function handleUserMeGet(): Promise<Response> {
  // The row seeds on first read — the profile exists (empty) before the
  // user's first edit, with a stable id from then on.
  const row = readProfileRow() ?? writeProfileRow({});
  return Response.json(toApiShape(row));
}

export async function handleUserMePatch(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fieldError("invalid_chars");
  }

  const parsed = UserProfilePatchSchema.safeParse(body);
  if (!parsed.success) {
    log.warn({ err: parsed.error }, "user-profile patch failed schema");
    return fieldError("invalid_chars");
  }

  const patch = parsed.data;
  if (patch.username !== undefined) {
    const code = checkUsernameRule(patch.username);
    if (code) {
      return fieldError(code);
    }
  }
  if (patch.email !== undefined && patch.email !== "" && !patch.email.includes("@")) {
    return Response.json(
      { email: [{ code: "invalid", string: "Enter a valid email address." }] },
      { status: 400 },
    );
  }

  const row = writeProfileRow({
    username: patch.username,
    email: patch.email,
    firstName: patch.first_name,
    lastName: patch.last_name,
  });
  return Response.json(toApiShape(row));
}

export async function handleUsernameAvailableGet(
  req: Request,
): Promise<Response> {
  const username = new URL(req.url).searchParams.get("username") ?? "";
  const code = checkUsernameRule(username);
  if (!code) {
    return Response.json({ available: true, code: null, message: null });
  }
  return Response.json({
    available: false,
    code,
    message: USERNAME_COPY[code],
  });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    path: "/user/me",
    method: "get",
    operationId: "userMeGet",
    summary: "Get the user's account profile",
    description:
      "The assistant tracks the user's profile for them — the record is " +
      "stored on the assistant and answered from its own database.",
    tags: ["settings"],
    responseBody: UserProfileSchema,
    auth: "edge-scoped",
    scope: "settings.read",
    scoped: true,
    handler: () => handleUserMeGet(),
  },
  {
    path: "/user/me",
    method: "patch",
    operationId: "userMePartialUpdate",
    summary: "Update the user's account profile",
    description:
      "Stored on the assistant. Handle rules are enforced locally and " +
      "failures come back as DRF field errors ({username: [{code, string}]}).",
    tags: ["settings"],
    requestBody: UserProfilePatchSchema,
    responseBody: UserProfileSchema,
    auth: "edge-scoped",
    scope: "settings.write",
    scoped: true,
    handler: (req) => handleUserMePatch(req),
  },
  {
    path: "/user/username-available",
    method: "get",
    operationId: "userUsernameAvailableGet",
    summary: "Check username availability",
    description:
      "A local format/reserved check — the assistant owns its user's " +
      "handle, so there is no global namespace to collide with.",
    tags: ["settings"],
    queryParameters: [{ name: "username", description: "The candidate handle" }],
    responseBody: UsernameAvailabilitySchema,
    auth: "edge-scoped",
    scope: "settings.read",
    scoped: true,
    handler: (req) => handleUsernameAvailableGet(req),
  },
];
