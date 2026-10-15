import { expect, test } from "bun:test";
import {
  RETIRED_BACKUP_PATH,
  retiredBackupResponse,
} from "./retired-backup.js";
test("legacy backup and migration URLs stop at the gateway", async () => {
  for (const path of [
    "/v1/backups",
    "/v1/backups/create",
    "/v1/assistants/self/backups/restore/",
    "/v1/migrations/export",
    "/v1/assistants/assistant-1/migrations/export",
    "/v1/migrations/import-from-gcs",
    "/v1/migrations/jobs/job-1",
  ]) {
    expect(RETIRED_BACKUP_PATH.test(path)).toBe(true);
  }
  for (const path of [
    "/v1/apps/import",
    "/v1/admin/rollback-migrations",
    "/v1/logs/export",
  ]) {
    expect(RETIRED_BACKUP_PATH.test(path)).toBe(false);
  }
  const response = retiredBackupResponse();
  expect(response.status).toBe(410);
  expect(await response.text()).toContain("vellum-to-cadet");
});
