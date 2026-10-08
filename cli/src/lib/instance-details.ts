/**
 * Canonical instance-detail rows shared by the hatch summaries and retire's
 * target preview, so every command describes an instance the same way.
 */
export interface InstanceDetails {
  /** Display name — printed when it differs from the id, or when there is no id. */
  name?: string;
  id?: string;
  cloud?: string;
  runtime?: string;
  /** Instance state dir (local hatches). */
  root?: string;
  /** Assistant container name (docker hatches). */
  container?: string;
}

/**
 * Print the detail rows in canonical order. Callers pass only the rows they
 * mean to show; the hatch summaries stay minimal while retire's preview shows
 * the full set.
 */
export function printInstanceDetails(
  details: InstanceDetails,
  log: (message: string) => void,
): void {
  const rows: Array<[string, string]> = [];
  if (details.name && (!details.id || details.name !== details.id)) {
    rows.push(["Name", details.name]);
  }
  if (details.id) rows.push(["ID", details.id]);
  if (details.cloud) rows.push(["Cloud", details.cloud]);
  if (details.runtime) rows.push(["Runtime", details.runtime]);
  if (details.root) rows.push(["Root", details.root]);
  if (details.container) rows.push(["Container", details.container]);
  for (const [label, value] of rows) {
    log(`  ${label}: ${value}`);
  }
}
