/**
 * The user's account profile — a gateway data-layer api over the
 * guardian's EXISTING rows.
 *
 * The assistant tracks the user's profile for them, and the profile has no
 * storage of its own: the handle rides the guardian's `cadet` channel
 * address, the email rides their `email` channel address, and the name is
 * the contact's displayName (the platform's first/last split is answered
 * from that one field). The operator api carries the availability check —
 * the data layer carries everything else.
 *
 * Handle rules are enforced locally with the platform's canonical error
 * codes in the DRF field-error wire shape ({username: [{code, string}]}),
 * so the bundles' field-error parser and error-copy maps work unchanged.
 * There is no global handle namespace on the assistant — "taken" never
 * fires locally; availability is a format check.
 */

import { z } from "zod";

import { getGatewayDb } from "../../db/connection.js";
import { ContactStore } from "../../db/contact-store.js";

import type { RouteDefinition } from "./types.js";

// ---------------------------------------------------------------------------
// Handle rules — the canonical codes the bundles already have copy for
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

export const USERNAME_COPY: Record<UsernameErrorCode, string> = {
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
  })
  .strict();

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function toApiShape(profile: {
  id: string;
  displayName: string;
  username: string | null;
  email: string | null;
}) {
  return {
    id: profile.id,
    username: profile.username ?? "",
    email: profile.email ?? "",
    first_name: profile.displayName,
    last_name: "",
  };
}

function unbound(): Response {
  // No guardian bound yet — the binding flow creates the guardian and its
  // channels; the profile reads as an empty shell until then.
  return Response.json(
    { id: "", username: "", email: "", first_name: "", last_name: "" },
  );
}

/** DRF field-error body — the wire shape the web's parser already speaks. */
function fieldError(code: UsernameErrorCode): Response {
  return Response.json(
    { username: [{ code, string: USERNAME_COPY[code] }] },
    { status: 400 },
  );
}

export async function handleUserMeGet(): Promise<Response> {
  const profile = new ContactStore(getGatewayDb()).getGuardianProfile();
  if (!profile) return unbound();
  return Response.json(toApiShape(profile));
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
    return fieldError("invalid_chars");
  }

  const username = parsed.data.username;
  if (username !== undefined) {
    const code = checkUsernameRule(username);
    if (code) {
      return fieldError(code);
    }
    const applied = new ContactStore(getGatewayDb()).setGuardianCadetAddress(
      username,
    );
    if (!applied) {
      return Response.json({ detail: "No guardian is bound to this assistant yet." }, { status: 404 });
    }
  }

  const profile = new ContactStore(getGatewayDb()).getGuardianProfile();
  if (!profile) return unbound();
  return Response.json(toApiShape(profile));
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
      "The assistant tracks the user's profile for them: the handle rides " +
      "the guardian's cadet channel address, the email their email channel, " +
      "and the name their contact displayName.",
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
      "Writes the guardian's cadet channel address. Handle rules are " +
      "enforced locally and failures come back as DRF field errors " +
      "({username: [{code, string}]}).",
    tags: ["settings"],
    requestBody: UserProfilePatchSchema,
    responseBody: UserProfileSchema,
    auth: "edge-scoped",
    scope: "settings.write",
    scoped: true,
    handler: (req) => handleUserMePatch(req),
  },
];
