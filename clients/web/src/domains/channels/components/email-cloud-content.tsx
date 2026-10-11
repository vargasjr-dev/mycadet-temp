import { Check, Copy, Loader2, Mail, Trash2 } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { useAssistantHandleModal } from "@/components/assistant-handle-modal";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { AssistantInboxUpgradeBody } from "@/domains/assistant-inbox/components/assistant-inbox-upgrade-body";
import {
  assistantsDomainsDestroyMutation,
  assistantsDomainsListOptions,
  assistantsDomainsListQueryKey,
  assistantsDomainsVerificationStatusRetrieveOptions,
  assistantsDomainsVerificationStatusRetrieveQueryKey,
  assistantsDomainsVerificationStatusRetrieveSetQueryData,
  assistantsEmailAddressesDestroyMutation,
  assistantsEmailAddressesListOptions,
  assistantsEmailAddressesListQueryKey,
  assistantsEmailAddressesStatusRetrieveOptions,
  assistantsEmailAddressesStatusRetrieveQueryKey,
  assistantsListQueryKey,
  organizationsBillingSubscriptionRetrieveOptions,
  useAssistantsDomainsProvisionCreateMutation,
} from "@/generated/api/@tanstack/react-query.gen";
import type { DomainVerificationStatusStatusEnum } from "@/generated/api/types.gen";
import {
  channelsReadinessGetQueryKey,
  channelsReadinessRefreshPostMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { captureError } from "@/lib/error-reporting/capture-error";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
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
  status: DomainVerificationStatusStatusEnum | undefined,
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
  assistantId: string;
  assistantHandle: string | undefined;
  emailRootDomain: string;
}

export function EmailCloudContent({
  assistantId,
  assistantHandle,
  emailRootDomain,
}: EmailCloudContentProps) {
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

  // -- Subscription gate (managed mode requires the cloud_email entitlement)
  // We read the `cloud_email` entitlement directly rather than inferring it
  // from the plan, so an admin `EntitlementOverride` (which flips a Base org to
  // entitled) is honored in-product. We separate "definitely not entitled"
  // from "unknown" so a failed subscription fetch (transient 5xx, network
  // blip) doesn't lock entitled users out of their own managed email. React
  // Query preserves last-known `data` across failed refetches, so
  // `isExplicitlyNotEntitled` only flips true when the server told us so. The
  // backend `assert_entitlement` remains the source of truth — this gate is
  // just a UX hint to keep non-entitled orgs out of a form that would 403
  // anyway.
  const subscriptionQuery = useQuery({
    ...organizationsBillingSubscriptionRetrieveOptions(),
    enabled: true,
  });
  const subscriptionData = subscriptionQuery.data;
  const entitlements = subscriptionData?.entitlements;
  const hasManagedEmail = entitlements?.cloud_email === true;
  // Only an explicit denial when the server returned an entitlements object that
  // omits cloud_email. A successful payload lacking entitlements entirely
  // (older platform deploy / partial response) is treated as unknown and fails
  // open, preserving the definitely-not vs unknown split.
  const isExplicitlyNotEntitled = !!entitlements && !hasManagedEmail;
  const subscriptionUnknown =
    !subscriptionData &&
    subscriptionQuery.isError &&
    !subscriptionQuery.isFetching;

  // -- Domain & address state ------------------------------------------------
  const domainsQuery = useQuery({
    ...assistantsDomainsListOptions({
      path: { assistant_id: assistantId },
    }),
    enabled: !isExplicitlyNotEntitled,
  });
  const addressesQuery = useQuery({
    ...assistantsEmailAddressesListOptions({
      path: { assistant_id: assistantId },
    }),
    enabled: !isExplicitlyNotEntitled,
  });

  const domain = domainsQuery.data?.results?.[0];
  const address = addressesQuery.data?.results?.[0];
  const fullDomain = domain ? `${domain.subdomain}.${emailRootDomain}` : null;

  const statusQuery = useQuery({
    ...assistantsEmailAddressesStatusRetrieveOptions({
      path: { assistant_id: assistantId, id: address?.id ?? "" },
    }),
    enabled: !!address?.id,
    refetchOnWindowFocus: false,
  });

  const verificationQuery = useQuery({
    ...assistantsDomainsVerificationStatusRetrieveOptions({
      path: { assistant_id: assistantId, id: domain?.id ?? "" },
    }),
    enabled: !!domain?.id,
    refetchInterval: (query) =>
      domainVerificationRefetchInterval(query.state.data?.status),
    refetchOnWindowFocus: true,
  });

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
  const deleteDomain = useMutation(assistantsDomainsDestroyMutation());
  const provisionDomain = useAssistantsDomainsProvisionCreateMutation();
  const deleteAddress = useMutation(assistantsEmailAddressesDestroyMutation());
  const refreshReadiness = useMutation(channelsReadinessRefreshPostMutation());

  const invalidateEmailQueries = useCallback(() => {
    const path = { assistant_id: assistantId };
    void queryClient.invalidateQueries({
      queryKey: assistantsDomainsListQueryKey({ path }),
    });
    void queryClient.invalidateQueries({
      queryKey: assistantsEmailAddressesListQueryKey({ path }),
    });
    if (address?.id) {
      void queryClient.invalidateQueries({
        queryKey: assistantsEmailAddressesStatusRetrieveQueryKey({
          path: { ...path, id: address.id },
        }),
      });
    }
    // Domain registration can change the assistant's handle; invalidate the
    // assistant list so the cached handle stays fresh.
    void queryClient.invalidateQueries({
      queryKey: assistantsListQueryKey(),
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
  const assistantName = useAssistantIdentityStore.use.name();
  const handleModal = useAssistantHandleModal(activeAssistantId);
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
      await deleteAddress.mutateAsync({
        path: { assistant_id: assistantId, id: address.id },
      });
      invalidateEmailQueries();
      refreshChannelReadiness();
      toast.success(t("emailCloudContent.emailRemovedToast"));
    } catch (err) {
      captureError(err, { context: "email_address_delete" });
      toast.error(t("emailCloudContent.emailRemoveFailedToast"));
    }
  }, [
    address?.id,
    assistantId,
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
      const result = await provisionDomain.mutateAsync({
        path: { assistant_id: assistantId, id: domain.id },
      });
      setRepairConfirmOpen(false);
      assistantsDomainsVerificationStatusRetrieveSetQueryData(
        queryClient,
        { path: { assistant_id: assistantId, id: domain.id } },
        result,
      );
      void queryClient.invalidateQueries({
        queryKey: assistantsDomainsVerificationStatusRetrieveQueryKey({
          path: { assistant_id: assistantId, id: domain.id },
        }),
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
      await deleteDomain.mutateAsync({
        path: { assistant_id: assistantId, id: domain.id },
      });
      invalidateEmailQueries();
      toast.success(t("emailCloudContent.domainReleasedToast"));
    } catch (err) {
      captureError(err, { context: "email_domain_release" });
      toast.error(t("emailCloudContent.domainReleaseFailedToast"));
    }
  }, [
    address,
    assistantId,
    deleteDomain,
    domain?.id,
    invalidateEmailQueries,
    t,
  ]);

  // -- Render ----------------------------------------------------------------
  if (subscriptionQuery.isLoading) {
    return (
      <div className="flex items-center gap-2 text-body-small-default text-[var(--content-tertiary)]">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t("emailCloudContent.checkingSubscription")}
      </div>
    );
  }

  if (isExplicitlyNotEntitled) {
    /* The Assistant Inbox's own pitch, so it reads the same from either
       door. No title here: the Email section's header carries the
       pitch's title and line in this state (see `EmailChannelSection`), and
       the body sits at the start under it rather than in a card of its own. */
    return (
      <>
        <AssistantInboxUpgradeBody
          assistantId={activeAssistantId}
          assistantName={assistantName ?? ""}
          handle={assistantHandle ?? ""}
          rootDomain={emailRootDomain}
          onEditHandle={handleModal.openModal ?? undefined}
          onUpgrade={() => navigate(routes.plans)}
          onSeePlans={() => navigate(routes.plans)}
          align="start"
        />
        {handleModal.modal}
      </>
    );
  }

  // subscriptionUnknown: billing service unreachable. Render warning above
  // the form but still show the form (fail-open). The backend
  // `assert_entitlement` remains the source of truth — if the user isn't
  // entitled, domain registration will 403.
  const subscriptionWarning = subscriptionUnknown ? (
    <Notice
      tone="warning"
      title={t("emailCloudContent.subscriptionWarningTitle")}
      actions={
        <Button
          size="compact"
          variant="outlined"
          onClick={() => subscriptionQuery.refetch()}
        >
          {t("emailCloudContent.retry")}
        </Button>
      }
    >
      {t("emailCloudContent.subscriptionWarningBody")}
    </Notice>
  ) : null;

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
    return (
      <div className="space-y-3">
        {subscriptionWarning}
        {inboxSetupNotice}
      </div>
    );
  }

  if (!address) {
    return (
      <div className="space-y-4">
        {subscriptionWarning}
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
      {subscriptionWarning}
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
