export function retiredBackupResponse(): Response {
  return Response.json(
    {
      error: "runtime_backups_retired",
      detail:
        "Use cadet backup and cadet restore for local or Docker installations, or the cloud backup API. Convert legacy .vbundle archives with vellum-to-cadet.",
    },
    { status: 410 },
  );
}

export const RETIRED_BACKUP_PATH =
  /^\/v1\/(?:migrations(?:\/.*)?|(?:assistants\/[^/]+\/)?backups(?:\/.*)?)\/?$/;
