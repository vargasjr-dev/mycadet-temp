import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, KeyRound, Link2, Loader2, Plus, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { useTranslation } from "@/i18n";
import {
  AddCredentialModal,
  credentialsListQueryKey,
} from "@/components/add-credential-modal";
import { DetailCard } from "@/components/detail-card";
import { NotFound } from "@/components/not-found";
import { useCredentialsDeletePostMutation } from "@/generated/daemon/@tanstack/react-query.gen";
import { credentialsListPost } from "@/generated/daemon/sdk.gen";
import { useSupportsCredentialsSettings } from "@/lib/backwards-compat/use-supports-credentials-settings";
import { copyToClipboard } from "@/lib/copy-to-clipboard";
import { captureError } from "@/lib/error-reporting/capture-error";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { shouldRetryDaemonError } from "@/utils/daemon-errors";
import { Button } from "@mycadet/design-library/components/button";
import { ConfirmDialog } from "@mycadet/design-library/components/confirm-dialog";
import { Input } from "@mycadet/design-library/components/input";
import { Modal } from "@mycadet/design-library/components/modal";
import {} from "@mycadet/design-library/components/segment-control";
import { toast } from "@mycadet/design-library/components/toast";

import {
  credentialInUseConnections,
  formatConnectionNames,
} from "./credential-in-use";
import { CredentialRow, type StoredCredential } from "./credential-row";
import {
  createCredentialRequest,
  credentialRequestExpiryToEpochMs,
} from "./credential-requests-api";

/** A cloud credential from the credentials list. Read-only. */

/** A freshly minted one-time credential-request link, shown in a modal. */
interface GeneratedLink {
  /** `service:field` of the credential the link fills. */
  name: string;
  url: string;
  /** Epoch (seconds or ms) the link expires at, when the daemon reports it. */
  expiresAt: number | null;
}

/** Below this count, scanning the list beats typing — so we hide the search. */
const SEARCH_VISIBILITY_THRESHOLD = 6;

/** Which credential group the segment control is showing. */

/**
 * A delete the daemon refused because provider connections still dispatch
 * through the credential, held until the user decides about those connections.
 */
interface InUseDeletion {
  credential: StoredCredential;
  connections: string[];
}

export function CredentialsPage() {
  const assistantId = useActiveAssistantId();
  // Older assistants don't serve the credentials-page routes (v0.10.8+); on
  // direct navigation render NotFound once the version is known, and nothing
  // while it hydrates. "Known" requires the identity snapshot to belong to
  // THIS assistant: mid-switch the store can still hold the previous
  // assistant's non-null version, which must read as unresolved, not 404.
  const supportsCredentials = useSupportsCredentialsSettings(assistantId);
  const identityAssistantId = useAssistantIdentityStore.use.assistantId();
  const versionResolvedForOwner =
    useAssistantIdentityStore.use.version() !== null &&
    identityAssistantId === assistantId;

  if (versionResolvedForOwner && !supportsCredentials) {
    return <NotFound />;
  }
  if (!supportsCredentials) {
    return null;
  }
  return <CredentialsPageInner />;
}

function CredentialsPageInner() {
  const { t } = useTranslation("settings");
  const assistantId = useActiveAssistantId();
  const queryClient = useQueryClient();

  const listQueryKey = credentialsListQueryKey(assistantId);
  const listQuery = useQuery({
    queryKey: listQueryKey,
    queryFn: async () => {
      const { data } = await credentialsListPost({
        path: { assistant_id: assistantId },
        body: {},
        throwOnError: true,
      });
      return {
        credentials: data.credentials as StoredCredential[],
      };
    },
    retry: shouldRetryDaemonError,
  });

  const credentials = useMemo(
    () => listQuery.data?.credentials ?? [],
    [listQuery.data],
  );
  // --- Ephemeral UI state ---

  const [isShowingAddForm, setIsShowingAddForm] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [pendingDeletion, setPendingDeletion] =
    useState<StoredCredential | null>(null);
  const [inUseDeletion, setInUseDeletion] = useState<InUseDeletion | null>(
    null,
  );
  const [generatedLink, setGeneratedLink] = useState<GeneratedLink | null>(
    null,
  );
  const [generatingLinkName, setGeneratingLinkName] = useState<string | null>(
    null,
  );

  // A credential an LLM connection resolves its auth through is refused on the
  // first attempt; the retry carries `force` once the user has seen which
  // connections the delete takes offline.
  const deleteMutation = useCredentialsDeletePostMutation({
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: listQueryKey });
      toast.success(
        t("credentialsPage.deleteSuccessToast", {
          name: `${variables.body.service}:${variables.body.field}`,
        }),
      );
    },
    onError: (err, variables) => {
      const connections = credentialInUseConnections(err);
      const credential = credentials.find(
        (candidate) =>
          candidate.service === variables.body.service &&
          candidate.field === variables.body.field,
      );
      if (connections && credential) {
        setInUseDeletion({ credential, connections });
        return;
      }
      captureError(err, { context: "credentials-delete" });
      toast.error(err.message || t("credentialsPage.deleteErrorToast"));
    },
  });

  const deletingName = deleteMutation.isPending
    ? `${deleteMutation.variables?.body?.service}:${deleteMutation.variables?.body?.field}`
    : null;

  const filteredCredentials = useMemo(() => {
    const needle = searchText.trim().toLowerCase();
    if (!needle) {
      return credentials;
    }
    return credentials.filter((credential) => {
      const haystack = [
        credential.service,
        credential.field,
        `${credential.service}:${credential.field}`,
        credential.alias ?? "",
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [credentials, searchText]);

  // When the list shrinks below the search threshold the input is unmounted, so
  // an in-progress query would keep filtering invisibly with no way to clear it.
  // Reset the text whenever search is hidden to avoid a stale, un-clearable filter.
  useEffect(() => {
    if (credentials.length <= SEARCH_VISIBILITY_THRESHOLD) {
      setSearchText("");
    }
  }, [credentials.length]);

  // --- Handlers ---

  const deleteCredential = (credential: StoredCredential, force: boolean) => {
    deleteMutation.mutate({
      path: { assistant_id: assistantId },
      body: {
        service: credential.service,
        field: credential.field,
        ...(force ? { force: true } : {}),
      },
    });
  };

  const confirmDelete = () => {
    const credential = pendingDeletion;
    setPendingDeletion(null);
    if (!credential) {
      return;
    }
    deleteCredential(credential, false);
  };

  const confirmForcedDelete = () => {
    const refused = inUseDeletion;
    setInUseDeletion(null);
    if (!refused) {
      return;
    }
    deleteCredential(refused.credential, true);
  };

  const handleGenerateLink = async (credential: StoredCredential) => {
    const name = `${credential.service}:${credential.field}`;
    setGeneratingLinkName(name);
    try {
      const result = await createCredentialRequest(assistantId, {
        service: credential.service,
        field: credential.field,
        label: credential.alias ?? undefined,
      });
      if (result.ok && result.url) {
        setGeneratedLink({
          name,
          url: result.url,
          expiresAt: result.expiresAt ?? null,
        });
      } else {
        toast.error(
          result.error || t("credentialsPage.generateLinkFailedToast"),
        );
      }
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("credentialsPage.generateLinkFailedToast"),
      );
    } finally {
      setGeneratingLinkName(null);
    }
  };

  const handleCopyGeneratedLink = () => {
    const url = generatedLink?.url;
    if (!url) {
      return;
    }
    copyToClipboard(url, {
      successMessage: t("credentialsPage.linkCopiedToast"),
      errorMessage: t("credentialsPage.linkCopyFailedToast"),
    });
  };

  // --- Render ---

  if (listQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-10">
        <Loader2 className="h-5 w-5 animate-spin text-[var(--content-disabled)]" />
      </div>
    );
  }

  const hasCredentials = credentials.length > 0;

  // Search stays hidden for short lists where scanning is faster than typing;
  // it only earns its place once the list is long enough to get unwieldy.
  const showSearch = credentials.length > SEARCH_VISIBILITY_THRESHOLD;

  return (
    <div className="space-y-4">
      <DetailCard
        title={t("credentialsPage.title")}
        subtitle={t("credentialsPage.subtitleOwn")}
        accessory={
          hasCredentials ? (
            <Button
              type="button"
              variant="primary"
              size="regular"
              onClick={() => setIsShowingAddForm(true)}
              leftIcon={<Plus aria-hidden />}
            >
              {t("credentialsPage.addButton")}
            </Button>
          ) : null
        }
      >
        <div className="space-y-4">
          {hasCredentials ? (
            <div className="space-y-3">
              {showSearch ? (
                <Input
                  type="text"
                  value={searchText}
                  onChange={(e) => setSearchText(e.target.value)}
                  placeholder={t("credentialsPage.searchPlaceholder")}
                  aria-label={t("credentialsPage.searchAriaLabel")}
                  leftIcon={<Search className="h-3.5 w-3.5" aria-hidden />}
                  fullWidth
                />
              ) : null}
              {filteredCredentials.length === 0 ? (
                <p className="px-1 py-2 text-body-medium-lighter text-[var(--content-tertiary)]">
                  {t("credentialsPage.noMatch", { query: searchText.trim() })}
                </p>
              ) : (
                <div className="space-y-2">
                  {filteredCredentials.map((credential) => {
                    const name = `${credential.service}:${credential.field}`;
                    return (
                      <CredentialRow
                        key={credential.credentialId ?? name}
                        credential={credential}
                        assistantId={assistantId}
                        generatingLink={generatingLinkName === name}
                        deleting={deletingName === name}
                        onGenerateLink={() =>
                          void handleGenerateLink(credential)
                        }
                        onDelete={() => setPendingDeletion(credential)}
                      />
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--surface-base)]">
                <KeyRound
                  className="h-6 w-6 text-[var(--content-disabled)] dark:text-[var(--content-default)]"
                  aria-hidden
                />
              </div>
              <h3 className="mt-4 text-title-small text-[var(--content-default)]">
                {t("credentialsPage.emptyTitle")}
              </h3>
              <p className="mt-1 text-body-medium-lighter text-[var(--content-tertiary)]">
                {t("credentialsPage.emptySubtitle")}
              </p>
            </div>
          )}

          {hasCredentials ? null : (
            <Button
              type="button"
              variant="outlined"
              size="compact"
              onClick={() => setIsShowingAddForm(true)}
              className="w-full border-dashed"
              leftIcon={<Plus aria-hidden />}
            >
              {t("credentialsPage.addCredentialButton")}
            </Button>
          )}
        </div>
      </DetailCard>

      <ConfirmDialog
        open={pendingDeletion !== null}
        title={t("credentialsPage.deleteConfirmTitle")}
        message={
          pendingDeletion
            ? t("credentialsPage.deleteConfirmMessage", {
                name: `${pendingDeletion.service}:${pendingDeletion.field}`,
              })
            : ""
        }
        confirmLabel={t("credentialsPage.deleteConfirmLabel")}
        destructive
        onConfirm={confirmDelete}
        onCancel={() => setPendingDeletion(null)}
      />

      <ConfirmDialog
        open={inUseDeletion !== null}
        title={t("credentialsPage.inUseTitle")}
        message={
          inUseDeletion
            ? t("credentialsPage.inUseMessage", {
                count: inUseDeletion.connections.length,
                name: `${inUseDeletion.credential.service}:${inUseDeletion.credential.field}`,
                connections: formatConnectionNames(inUseDeletion.connections),
              })
            : ""
        }
        confirmLabel={t("credentialsPage.inUseConfirmLabel")}
        destructive
        onConfirm={confirmForcedDelete}
        onCancel={() => setInUseDeletion(null)}
      />

      <AddCredentialModal
        open={isShowingAddForm}
        onClose={() => setIsShowingAddForm(false)}
      />

      <Modal.Root
        open={generatedLink !== null}
        onOpenChange={(open) => {
          if (!open) {
            setGeneratedLink(null);
          }
        }}
      >
        <Modal.Content size="sm">
          <Modal.Header icon={Link2}>
            <Modal.Title>
              {t("credentialsPage.oneTimeLinkModalTitle")}
            </Modal.Title>
            <Modal.Description>
              {generatedLink
                ? t("credentialsPage.oneTimeLinkModalDescription", {
                    name: generatedLink.name,
                    expiresClause:
                      generatedLink.expiresAt !== null
                        ? t("credentialsPage.oneTimeLinkModalExpiresClause", {
                            expiresAt: new Date(
                              credentialRequestExpiryToEpochMs(
                                generatedLink.expiresAt,
                              ),
                            ).toLocaleString(),
                          })
                        : "",
                  })
                : ""}
            </Modal.Description>
          </Modal.Header>
          <Modal.Body>
            <Input
              label={t("credentialsPage.linkLabel")}
              type="text"
              readOnly
              value={generatedLink?.url ?? ""}
              onFocus={(e) => e.currentTarget.select()}
              fullWidth
            />
          </Modal.Body>
          <Modal.Footer>
            <Button
              type="button"
              size="compact"
              onClick={handleCopyGeneratedLink}
              leftIcon={<Copy aria-hidden />}
            >
              {t("credentialsPage.copyLinkButton")}
            </Button>
          </Modal.Footer>
        </Modal.Content>
      </Modal.Root>
    </div>
  );
}
