import { Check, Copy, Mail, Trash2 } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { useDestroyEmailAddress, useEmailAddressStatus, useEmailAddresses, emailKeys } from "@/lib/email-api";
import {
  useDestroyDomain,
  useDomains,
  useDomainVerificationStatus,
  useProvisionDomain,
  domainKeys,
  type DomainVerificationStatus,
} from "@/lib/assistant-domains";
import {
  channelsReadinessGetQueryKey,
  channelsReadinessRefreshPostMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { captureError } from "@/lib/error-reporting/capture-error";
import { extractErrorMessage } from "@/utils/api-errors";
import { routes } from "@/utils/routes";
import { Button } from "@mycadet/design-library/components/button";
import { ConfirmDialog } from "@mycadet/design-library/components/confirm-dialog";
import { Input } from "@mycadet/design-library/components/input";
import { Notice } from "@mycadet/design-library/components/notice";
import { toast } from "@mycadet/design-library/components/toast";

import { Trans, useTranslation } from "@/i18n";

import { DomainVerificationChip } from "@/components/domain-verification-chip";

const CONFIRM_CODE_CLASS =
  "rounded bg-[var(--surface-active)] px-1 py-0.5 font-mono text-[0.9em]";

export const DOMAIN_VERIFICATION_POLL_MS = 10_000;

/**
 * Poll cadence for domain verification. `not_started` means the provider does
 * not have the domain yet, so a status poll cannot make progress until the
 * user runs Complete domain setup.
 */
export function domainVerificationRefetchInterval(
  status: DomainVerificationStatus | undefined,
): number | false {
  if (
    status === "verified" ||
    status === "failed" ||
    status === "not_started"
  ) {
    return false;
  }
  return DOMAIN_VERIFICATION_POLL_MS;
}

interface EmailCloudContentProps {
  emailRootDomain: string;
}

export function EmailCloudContent({ emailRootDomain }: EmailCloudContentProps) {
  const assistantId = useActiveAssistantId();
  const { t } = useTranslation("channels");
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [releaseConfirmOpen, setReleaseConfirmOpen] = useState(false);
  const [removeAddressConfirmOpen, setRemoveAddressConfirmOpen] =
    useState(false);
  const [repairConfirmOpen, setRepairConfirmOpen] = useState(false);
  const [repairError, setRepairError] = useState<string | null>(null);
  const addressInputId = useId();
  const { copied: copiedAddress, copy: copyAddress } = useCopyToClipboard({
    errorMessage: t("emailCloudContent.copyAddressFailed"),
  });

  // -- Domain & address state ------------------------------------------------
  const domainsQuery = useDomains(assistantId);
  const addressesQuery = useEmailAddresses(assistantId);

  const domain = domainsQuery.data?.[0];
  const address = addressesQuery.data?.[0];
  const fullDomain = domain ? `${domain.subdomain}.${emailRootDomain}` : null;

  const statusQuery = useEmailAddressStatus(assistantId, address?.id, {
    refetchOnWindowFocus: false,
  });

  const verificationQuery = useDomainVerificationStatus(
    assistantId,
    domain?.id,
    {
      refetchInterval: (query) =>
        domainVerificationRefetchInterval(query.state.data?.status),
      refetchOnWindowFocus: true,
    },
  );

  useEffect(() => {
    if (searchParams.get("release") !== "1" || !domain || address) {
      return;
    }
    setReleaseConfirmOpen(true);
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("release");
        return next;
      },
      { replace: true },
    );
  }, [address, domain, searchParams, setSearchParams]);

  // -- Mutations -------------------------------------------------------------
  const deleteDomain = useDestroyDomain(assistantId);
  const provisionDomain = useProvisionDomain(assistantId);
  const deleteAddress = useDestroyEmailAddress(assistantId);
  const refreshReadiness = useMutation(channelsReadinessRefreshPostMutation());

  const invalidateEmailQueries = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: domainKeys.domains(assistantId),
    });
    void queryClient.invalidateQueries({
      queryKey: emailKeys.emailAddresses(assistantId),
    });
    if (address?.id) {
      void queryClient.invalidateQueries({
        queryKey: emailKeys.emailAddressStatus(assistantId, address.id),
      });
    }
    // Domain registration can change the assistant's handle; invalidate the
    // assistant list so the cached handle stays fresh. Matched by the
    // generated cache's id field — the sdk's key helper is not imported.
    void queryClient.invalidateQueries({
      queryKey: [{ _id: "assistantsList" }],
    });
  }, [address?.id, assistantId, queryClient]);

  // The channel list's Connected / Not connected badge reads the daemon's
  // readiness snapshot, whose inbox check the daemon caches for minutes.
  // Address changes here go straight to the cloud, so the daemon must be
  // told to re-check or the badge keeps the pre-change answer for the TTL.
  // Keyed on the ACTIVE assistant id, not this component's `assistantId`
  // prop: the prop is the cloud UUID the cloud routes need, while the
  // daemon readiness query in `useAssistantChannels` is cached under the
  // active id (a local slug on self-hosted assistants).
  const activeAssistantId = useActiveAssistantId();
  const refreshReadinessMutateAsync = refreshReadiness.mutateAsync;
  const refreshChannelReadiness = useCallback(() => {
    void refreshReadinessMutateAsync({
      path: { assistant_id: activeAssistantId },
      body: { channel: "email" },
    })
      .catch(() => {
        // Best-effort: the readiness poll converges after the daemon TTL.
      })
      .finally(() => {
        void queryClient.invalidateQueries({
          queryKey: channelsReadinessGetQueryKey({
            path: { assistant_id: activeAssistantId },
          }),
        });
      });
  }, [activeAssistantId, queryClient, refreshReadinessMutateAsync]);

  // -- Handlers --------------------------------------------------------------
  const handleDeleteAddress = useCallback(async () => {
    if (!address?.id) {
      return;
    }
    setRemoveAddressConfirmOpen(false);
    try {
      await deleteAddress.mutateAsync(address.id);
      invalidateEmailQueries();
      refreshChannelReadiness();
      toast.success(t("emailCloudContent.emailRemovedToast"));
    } catch (err) {
      captureError(err, { context: "email_address_delete" });
      toast.error(t("emailCloudContent.emailRemoveFailedToast"));
    }
  }, [
    address?.id,
    deleteAddress,
    invalidateEmailQueries,
    refreshChannelReadiness,
    t,
  ]);

  const handleProvisionDomain = useCallback(async () => {
    if (!domain?.id || provisionDomain.isPending) {
      return;
    }
    setRepairError(null);
    try {
      const result = await provisionDomain.mutateAsync(domain.id);
      setRepairConfirmOpen(false);
      queryClient.setQueryData(
        domainKeys.domainVerificationStatus(assistantId, domain.id),
        result,
      );
      void queryClient.invalidateQueries({
        queryKey: domainKeys.domainVerificationStatus(assistantId, domain.id),
      });
      toast.success(t("emailCloudContent.repairStartedToast"));
    } catch (err) {
      captureError(err, { context: "email_domain_provision" });
      const message = extractErrorMessage(
        err,
        undefined,
        t("emailCloudContent.repairFailedFallback"),
      );
      setRepairError(message);
      toast.error(message);
    }
  }, [assistantId, domain?.id, provisionDomain, queryClient, t]);

  const handleDeleteDomain = useCallback(async () => {
    if (!domain?.id) {
      return;
    }
    if (address) {
      toast.error(t("emailCloudContent.removeAddressFirstToast"));
      return;
    }
    setReleaseConfirmOpen(false);
    try {
      await deleteDomain.mutateAsync(domain.id);
      invalidateEmailQueries();
      toast.success(t("emailCloudContent.domainReleasedToast"));
    } catch (err) {
      captureError(err, { context: "email_domain_release" });
      toast.error(t("emailCloudContent.domainReleaseFailedToast"));
    }
  }, [
    address,
    deleteDomain,
    domain?.id,
    invalidateEmailQueries,
    t,
  ]);

  // -- Render ----------------------------------------------------------------
  /* The address is created from the Assistant Inbox's own setup card, the
     one place that also opens the mailbox once it exists. This section
     points there instead of carrying a second way to register: an address
     made here would leave the inbox with nothing to show for it. */
  const inboxSetupNotice = (
    <Notice
      tone="info"
      icon={<Mail className="h-4 w-4" aria-hidden />}
      title={t("emailCloudContent.inboxSetupTitle")}
      actions={
        <Button
          size="compact"
          onClick={() => navigate(routes.assistantInbox)}
          data-testid="email-inbox-setup-button"
        >
          {t("emailCloudContent.inboxSetupButton")}
        </Button>
      }
    >
      {t("emailCloudContent.inboxSetupBody")}
    </Notice>
  );

  if (!domain) {
    return <div className="space-y-3">{inboxSetupNotice}</div>;
  }

  if (!address) {
    return (
      <div className="space-y-4">
        <div className="space-y-1.5">
          <label className="block text-body-small-default text-[var(--content-tertiary)]">
            {t("emailCloudContent.domainLabel")}
          </label>
          <div className="flex items-center gap-2">
            <span className="font-mono text-body-small-default text-[var(--content-default)]">
              {domain.subdomain}.{emailRootDomain}
            </span>
            <DomainVerificationChip
              status={verificationQuery.data?.status}
              isLoading={verificationQuery.isLoading}
            />
            <Button
              variant="dangerGhost"
              size="compact"
              iconOnly={<Trash2 />}
              onClick={() => setReleaseConfirmOpen(true)}
              disabled={deleteDomain.isPending}
              aria-label={t("emailCloudContent.releaseDomainAriaLabel")}
            />
          </div>
          <ConfirmDialog
            open={releaseConfirmOpen}
            title={t("emailCloudContent.releaseDomainTitle")}
            message={
              <Trans
                i18nKey="emailCloudContent.releaseDomainConfirmMessage"
                ns="channels"
                values={{
                  domain: `${domain.subdomain}.${emailRootDomain}`,
                }}
                components={{
                  code: <code className={CONFIRM_CODE_CLASS} />,
                }}
              />
            }
            confirmLabel={t("emailCloudContent.releaseConfirm")}
            destructive
            onConfirm={handleDeleteDomain}
            onCancel={() => setReleaseConfirmOpen(false)}
          />
        </div>

        {/* The domain row stays: releasing a domain is offered only here. */}
        {inboxSetupNotice}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        {/* The domain's verification sits on the label's line, so the field
            under it holds the address alone and the trailing controls are
            the two things to do with it: copy it, or remove it. */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label
            htmlFor={addressInputId}
            className="block text-body-small-default text-[var(--content-tertiary)]"
          >
            {t("emailCloudContent.addressLabel")}
          </label>
          <DomainVerificationChip
            status={verificationQuery.data?.status}
            isLoading={verificationQuery.isLoading}
          />
        </div>
        <div className="flex items-center gap-2">
          <Input
            id={addressInputId}
            value={address.address}
            readOnly
            fullWidth
            wrapperClassName="min-w-0 flex-1"
            className="font-mono"
          />
          {/* Both controls hold the field's own height on touch too, so
              the row reads as one line of the same size. */}
          <Button
            variant="outlined"
            iconOnly={copiedAddress ? <Check /> : <Copy />}
            expandOnMobile={false}
            onClick={() => copyAddress(address.address)}
            aria-label={t("emailCloudContent.copyAddressAriaLabel")}
            title={
              copiedAddress
                ? t("emailCloudContent.copiedAddress")
                : t("emailCloudContent.copyAddressAriaLabel")
            }
          />
          <Button
            variant="dangerGhost"
            iconOnly={<Trash2 />}
            expandOnMobile={false}
            onClick={() => setRemoveAddressConfirmOpen(true)}
            disabled={deleteAddress.isPending}
            aria-label={t("emailCloudContent.removeEmailAriaLabel")}
          />
        </div>
        <ConfirmDialog
          open={removeAddressConfirmOpen}
          title={t("emailCloudContent.removeEmailTitle")}
          message={
            <Trans
              i18nKey="emailCloudContent.removeEmailConfirmMessage"
              ns="channels"
              values={{ address: address.address }}
              components={{
                code: <code className={CONFIRM_CODE_CLASS} />,
              }}
            />
          }
          confirmLabel={t("emailCloudContent.removeConfirm")}
          destructive
          onConfirm={handleDeleteAddress}
          onCancel={() => setRemoveAddressConfirmOpen(false)}
        />
      </div>

      {verificationQuery.data?.status === "not_started" && (
        <>
          <Notice
            tone="warning"
            title={t("emailCloudContent.repairNoticeTitle")}
            actions={
              <Button
                size="compact"
                onClick={() => {
                  setRepairError(null);
                  setRepairConfirmOpen(true);
                }}
                disabled={provisionDomain.isPending}
              >
                {provisionDomain.isPending
                  ? t("emailCloudContent.completingSetup")
                  : t("emailCloudContent.completeSetup")}
              </Button>
            }
          >
            {t("emailCloudContent.repairNoticeBody")}
          </Notice>
          <ConfirmDialog
            open={repairConfirmOpen}
            title={t("emailCloudContent.repairConfirmTitle")}
            message={
              <Trans
                i18nKey="emailCloudContent.repairConfirmMessage"
                ns="channels"
                values={{ domain: fullDomain }}
                components={{
                  code: <code className={CONFIRM_CODE_CLASS} />,
                }}
              />
            }
            confirmLabel={t("emailCloudContent.completeSetup")}
            isPending={provisionDomain.isPending}
            error={repairError}
            onConfirm={() => {
              void handleProvisionDomain();
            }}
            onCancel={() => {
              if (!provisionDomain.isPending) {
                setRepairConfirmOpen(false);
              }
            }}
          />
        </>
      )}

      {statusQuery.data?.usage && (
        <p className="text-body-small-default text-[var(--content-tertiary)]">
          {t("emailCloudContent.usageSummary", {
            sent: statusQuery.data.usage.sent_today,
            limit: statusQuery.data.usage.daily_limit,
            received: statusQuery.data.usage.received_today,
          })}
        </p>
      )}
    </div>
  );
}
