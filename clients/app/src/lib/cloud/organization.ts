import { z } from "zod";
import { getCloud, type CloudResult } from "@app/lib/cloud/request";

const OrganizationPageSchema = z.object({
  results: z.array(z.object({ id: z.string().min(1) })),
  next: z.string().nullable().optional(),
});
const SELECTION_KEY = "cadet_active_organization_id";
function readSelection(): string | null {
  try {
    return sessionStorage.getItem(SELECTION_KEY);
  } catch {
    return null;
  }
}

/** Resolve the current selection against fresh membership; retain no cross-account cache. */
export async function resolveOrganization(
  signal?: AbortSignal,
): Promise<CloudResult<string>> {
  const ids: string[] = [];
  for (let page = 0; page < 20; page++) {
    const result = await getCloud(
      `/v1/organizations/?limit=100&offset=${ids.length}`,
      OrganizationPageSchema,
      { signal },
    );
    if (!result.ok) {
      return result;
    }
    ids.push(...result.data.results.map((org) => org.id));
    if (!result.data.next || result.data.results.length === 0) {
      const selected = readSelection();
      const id = selected && ids.includes(selected) ? selected : ids[0];
      return id
        ? { ok: true, status: result.status, data: id }
        : {
            ok: false,
            status: result.status,
            error: { detail: "No organization available for this account." },
          };
    }
  }
  return {
    ok: false,
    status: 200,
    error: { detail: "Organization list exceeded the page cap." },
  };
}
