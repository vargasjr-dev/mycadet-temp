/**
 * The `/account/doctor` page: the Doctor as an ACCOUNT surface.
 *
 * The doctor's main use case is an assistant that is broken — including
 * its gateway being completely offline — so the panel cannot live in the
 * web bundle (whose settings it used to grace) nor dial the gateway. It
 * lives here, dials the operator surface's unscoped spelling (the host
 * resolves the active assistant and proxies to the cloud on its own
 * credentials), and renders with no assistant selection in play.
 */

import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "@app/i18n";
import { DoctorAvatar } from "@app/domains/account/doctor/doctor-avatar";
import { DoctorPanel } from "@app/domains/account/doctor/doctor-panel";

interface ListAssistantsResponse {
  status: string;
}

function DoctorPageInner() {
  const { t } = useTranslation("doctor");

  // The one account-level guard: with nothing hatched there is nothing to
  // doctor. The lockfile read is host-side — no gateway dependency.
  const listQuery = useQuery({
    queryKey: ["doctor-page-assistants"],
    queryFn: async (): Promise<ListAssistantsResponse | null> => {
      const response = await fetch("/v1/assistants/");
      if (!response.ok) {
        return null;
      }
      return (await response.json()) as ListAssistantsResponse;
    },
  });

  if (listQuery.data?.status === "empty") {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 py-12">
        <DoctorAvatar className="h-24 w-24 shrink-0" />
        <p className="max-w-md text-center text-body-medium-lighter text-[var(--content-tertiary)]">
          {t("doctorPage.empty")}
        </p>
      </div>
    );
  }

  return <DoctorPanel />;
}

export function DoctorPage() {
  return (
    <div className="flex min-h-dvh flex-col bg-[var(--surface-canvas)]">
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col p-4">
        <DoctorPageInner />
      </div>
    </div>
  );
}
