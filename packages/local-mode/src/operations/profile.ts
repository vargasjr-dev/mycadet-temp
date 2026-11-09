/**
 * The operator profile operation — the user's account profile, stored on
 * the guardian's own contact row.
 *
 * Per the cloud-client census, the profile is assistant API the assistant
 * tracks for the user — refined: it is an OPERATOR api (mounted by the
 * serving hosts, reachable from the app bundle's page that will eventually
 * replace the cloud's /account/profile), and its storage is the guardian's
 * EXISTING row in the gateway's `contacts` table — no new table. The
 * profile columns ride the row the guardian bootstrap already creates when
 * the user binds their assistant.
 *
 * Only entries whose gateway database is a host-local file answer here
 * (local assistants): the operation opens the entry's gateway.sqlite
 * directly — the same path the local spawner hands the gateway as
 * GATEWAY_SECURITY_DIR. Containerized/hosted gateways pass through (null)
 * and the pre-existing chain answers.
 *
 * Handle rules are enforced locally with the platform's canonical error
 * codes (the same DRF field-error wire shape, so the bundles' field-error
 * parser and error-copy maps work unchanged). The assistant owns its
 * user's handle — there is no global namespace, so "taken" never fires;
 * availability is a pure format check.
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { z } from "zod";

import { getLocalInstanceDir } from "../remotes/local/instance";
import { findAssistantByName } from "./lookup";

import type { OperatorRequest } from "./routes";

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

/** Check a candidate handle against the local handle rules. */
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

/** The platform's DRF field-error shape: {field: [{code, string}]}. */
function fieldError(code: UsernameErrorCode): Response {
  return Response.json(
    { username: [{ code, string: USERNAME_COPY[code] }] },
    { status: 400 },
  );
}

function detailError(detail: string, status: number): Response {
  return Response.json({ detail }, { status });
}

// ---------------------------------------------------------------------------
// Guardian contact-row storage — the entry's host-local gateway database
// ---------------------------------------------------------------------------

interface GuardianProfile {
  id: string;
  username: string;
  email: string;
  firstName: string;
  lastName: string;
}

/**
 * Open the entry's gateway database read-only-ish for the profile columns.
 * Returns null when the entry is not host-local (its gateway database is
 * not a file on this host) — the caller passes the request through.
 * Throws (caller maps to 503) when the database predates the profile
 * columns — the gateway must restart once to push the schema.
 */
function openGuardianDb(
  assistantId: string,
): { db: Database; profile: GuardianProfile | null } | null {
  const entry = findAssistantByName(assistantId);
  // Only a local assistant's gateway database is a file on this host —
  // containerized and hosted gateways are not directly reachable, so those
  // entries pass through (null) and the pre-existing chain answers.
  if (!entry || entry.cloud !== "local") {
    return null;
  }
  const dbPath = join(
    getLocalInstanceDir(entry),
    "gateway-security",
    "gateway.sqlite",
  );
  const db = new Database(dbPath);
  const hasColumns = db
    .prepare(
      "SELECT COUNT(*) AS n FROM pragma_table_info('contacts') " +
        "WHERE name IN ('username','email','first_name','last_name')",
    )
    .get() as { n: number };
  if (hasColumns.n !== 4) {
    db.close();
    throw new Error(
      "the assistant's gateway predates the profile columns — restart it once to push the schema",
    );
  }
  const row = db
    .prepare(
      "SELECT id, username, email, first_name, last_name FROM contacts " +
        "WHERE role = 'guardian' ORDER BY created_at LIMIT 1",
    )
    .get() as
    | { id: string; username: string | null; email: string | null; first_name: string | null; last_name: string | null }
    | undefined;
  return {
    db,
    profile: row
      ? {
          id: row.id,
          username: row.username ?? "",
          email: row.email ?? "",
          firstName: row.first_name ?? "",
          lastName: row.last_name ?? "",
        }
      : null,
  };
}

function toApiShape(profile: GuardianProfile | null) {
  // An unbound assistant has no guardian row yet — the shell reads as an
  // empty profile (the binding flow creates the row; the profile page is
  // the bound-user surface).
  return {
    id: profile?.id ?? "",
    username: profile?.username ?? "",
    email: profile?.email ?? "",
    first_name: profile?.firstName ?? "",
    last_name: profile?.lastName ?? "",
  };
}

// ---------------------------------------------------------------------------
// Route runners
// ---------------------------------------------------------------------------

/** The profile read: the guardian's contact row, answered host-side. */
export async function runProfileGetRoute(
  request: OperatorRequest,
): Promise<Response | null> {
  let opened: ReturnType<typeof openGuardianDb>;
  try {
    opened = openGuardianDb(request.assistantId);
  } catch (error) {
    return detailError((error as Error).message, 503);
  }
  if (!opened) {
    return null;
  }
  const { db, profile } = opened;
  db.close();
  return Response.json(toApiShape(profile));
}

const PatchBodySchema = z.object({
  username: z.string().optional(),
  email: z.string().optional(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
});

/** The profile write: the guardian's contact row, updated host-side. */
export async function runProfilePatchRoute(
  request: OperatorRequest,
): Promise<Response | null> {
  const body = await readJsonBody(request.body);
  if (!body) {
    return detailError("Malformed JSON body.", 400);
  }
  const parsed = PatchBodySchema.safeParse(body);
  if (!parsed.success) {
    return detailError("Unexpected profile fields.", 400);
  }
  if (parsed.data.username !== undefined) {
    const code = checkUsernameRule(parsed.data.username);
    if (code) {
      return fieldError(code);
    }
  }
  if (
    parsed.data.email !== undefined &&
    parsed.data.email !== "" &&
    !parsed.data.email.includes("@")
  ) {
    return Response.json(
      { email: [{ code: "invalid", string: "Enter a valid email address." }] },
      { status: 400 },
    );
  }

  let opened: ReturnType<typeof openGuardianDb>;
  try {
    opened = openGuardianDb(request.assistantId);
  } catch (error) {
    return detailError((error as Error).message, 503);
  }
  if (!opened) {
    return null;
  }
  const { db, profile } = opened;
  if (!profile) {
    db.close();
    return detailError(
      "No guardian is bound to this assistant yet — bind it before editing the profile.",
      404,
    );
  }
  db.prepare(
    "UPDATE contacts SET username = ?, email = ?, first_name = ?, last_name = ?, " +
      "updated_at = ? WHERE id = ? AND role = 'guardian'",
  ).run(
    parsed.data.username ?? profile.username,
    parsed.data.email ?? profile.email,
    parsed.data.first_name ?? profile.firstName,
    parsed.data.last_name ?? profile.lastName,
    Date.now(),
    profile.id,
  );
  const updated = db
    .prepare(
      "SELECT id, username, email, first_name, last_name FROM contacts WHERE id = ?",
    )
    .get(profile.id) as {
    id: string;
    username: string | null;
    email: string | null;
    first_name: string | null;
    last_name: string | null;
  };
  db.close();
  return Response.json(
    toApiShape({
      id: updated.id,
      username: updated.username ?? "",
      email: updated.email ?? "",
      firstName: updated.first_name ?? "",
      lastName: updated.last_name ?? "",
    }),
  );
}

/** Availability: a local format check — the assistant owns its user's handle. */
export async function runUsernameAvailableRoute(
  request: OperatorRequest,
): Promise<Response | null> {
  const url = new URL(request.path ?? "/", "http://localhost");
  const username = url.searchParams.get("username") ?? "";
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

/**
 * Buffer and parse a JSON request body (mirrors routes.ts's helper — kept
 * local so the operation stays self-contained without a circular import).
 */
async function readJsonBody(
  body: ReadableStream | null | undefined,
): Promise<Record<string, unknown> | null> {
  const text = body ? await new Response(body).text().catch(() => "") : "";
  if (text.trim().length === 0) {
    return {};
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}
