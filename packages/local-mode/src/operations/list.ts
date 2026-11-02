import { readLockfile } from "../lockfile";

function listResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * The list assistants operation — the UNSCOPED `GET /v1/assistants/` is the
 * list CONTRACT: the lockfile says what is on the machine, and the answer is
 * the same union the shell's resolution hands a chooser. Nothing hatched is
 * `empty`; anything else is a `selection` whose rows name every entry (the
 * id, its display name when it has one, and its remote kind) without ever
 * carrying a credential field. The chooser hook, the lockfile store's
 * consumers, and the resolution's own unscoped arm all read this one
 * contract.
 */
export async function runListRoute(): Promise<Response> {
  const lockfile = readLockfile();
  if (lockfile.assistants.length === 0) {
    return listResponse({ status: "empty" });
  }
  return listResponse({
    status: "selection",
    assistants: lockfile.assistants.map((entry) => ({
      id: entry.assistantId,
      name: entry.name,
      remote: entry.cloud,
    })),
  });
}
