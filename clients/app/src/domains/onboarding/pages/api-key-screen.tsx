import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

import { AccountShell } from "@app/components/account/account-shell";
import { ExternalAnchor } from "@app/components/external-anchor";
import {
  NEW_ASSISTANT_PARAM,
  onboardingDestinationAfterConsent,
} from "@app/domains/onboarding/onboarding-destination";
import { SETUP_NAVIGATE } from "@app/domains/onboarding/onboarding-navigation";
import {
  DEFAULT_ONBOARDING_PROVIDER,
  ONBOARDING_PROVIDERS,
  defaultModelForOnboardingProvider,
  onboardingProvider,
  type OnboardingProviderId,
} from "@app/domains/onboarding/provider-catalog";
import {
  peekPendingProviderKey,
  setPendingProviderKey,
} from "@app/domains/onboarding/provider-key";
import { isLocalClient } from "@app/lib/runtime-mode";
import { useTranslation } from "@app/i18n";
import { routes } from "@app/utils/routes";
import { Button } from "@mycadet/design-library/components/button";
import { Input } from "@mycadet/design-library/components/input";
import { Select } from "@mycadet/design-library/components/select";

/**
 * 16px inputs under the compact `touch-mobile` guard (width < 48rem and
 * `pointer: coarse`) so iOS Safari doesn't zoom the field on focus. LUM-2597.
 */
const MOBILE_INPUT_NO_ZOOM = "touch-mobile:text-[16px]";

/**
 * The funnel's model-provider step, ported from web's
 * `/assistant/onboarding/api-key` — now `/account/onboarding/api-key`, rendered
 * with the account screens' compact chrome. Stages the collected key in
 * sessionStorage for the hatching screen to consume (see `provider-key`).
 */
export function ApiKeyScreen() {
  const { t } = useTranslation("account");
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const hosting = searchParams.get("hosting");
  const pendingProviderKey = peekPendingProviderKey();

  const [provider, setProvider] = useState<OnboardingProviderId>(
    () => pendingProviderKey?.provider ?? DEFAULT_ONBOARDING_PROVIDER.id,
  );
  const [apiKey, setApiKey] = useState(() => pendingProviderKey?.key ?? "");
  const [model, setModel] = useState(
    () =>
      pendingProviderKey?.model ??
      defaultModelForOnboardingProvider(
        pendingProviderKey?.provider ?? DEFAULT_ONBOARDING_PROVIDER.id,
      ) ??
      "",
  );
  const [baseUrl, setBaseUrl] = useState(
    () => pendingProviderKey?.baseUrl ?? "",
  );
  const [customModels, setCustomModels] = useState(
    () => pendingProviderKey?.customModels ?? "",
  );

  const entry = onboardingProvider(provider) ?? DEFAULT_ONBOARDING_PROVIDER;
  const models = entry.models ?? [];
  const requiresKey = entry.requiresKey;
  const requiresModel = models.length > 0;
  const isOpenAICompatible = provider === "openai-compatible";
  const keyRequired = requiresKey && !isOpenAICompatible;
  const canContinue =
    (!keyRequired || apiKey.trim().length > 0) &&
    (!requiresModel || model.trim().length > 0) &&
    (!isOpenAICompatible ||
      (baseUrl.trim().length > 0 && customModels.trim().length > 0));

  const onContinue = () => {
    if (!canContinue) {
      return;
    }
    const selectedModel =
      model.trim() || defaultModelForOnboardingProvider(provider);
    setPendingProviderKey({
      provider,
      key: apiKey.trim(),
      ...(selectedModel ? { model: selectedModel } : {}),
      ...(isOpenAICompatible
        ? {
            baseUrl: baseUrl.trim(),
            customModels: customModels.trim(),
          }
        : {}),
    });
    // Reaching this screen at all means an assistant is being provisioned, so
    // the funnel continuation always carries the marker.
    const params = new URLSearchParams({ [NEW_ASSISTANT_PARAM]: "1" });
    if (hosting) {
      params.set("hosting", hosting);
    }
    const qs = params.toString();
    // Consent settles at the shell's screen before this funnel runs, so the
    // continue hands straight to the post-consent destination: a local-hosting
    // onboarding (hosting=local/docker in a local-mode build) must run the
    // foreground local hatch first, so it goes to `hatching`, which then
    // redirects into the research flow. Cadet-Cloud goes straight to research
    // (managed background hatch). Web's copy also probes the selected
    // assistant's onboarded stamp here, but this call pins newAssistant: true,
    // which mutes that probe — the port drops it.
    const isLocalHatch =
      isLocalClient() && hosting !== null && hosting !== "cadet-cloud";
    const destination = onboardingDestinationAfterConsent({
      isLocalHatch,
      newAssistant: true,
    });
    void navigate(`${destination}${qs ? `?${qs}` : ""}`, SETUP_NAVIGATE);
  };

  const onBack = () => {
    void navigate(routes.account.onboarding.hosting, SETUP_NAVIGATE);
  };

  return (
    <AccountShell>
      <div className="flex w-full flex-col items-center text-center text-[var(--content-default)]">
        <h1 className="text-3xl font-semibold tracking-tight">
          {t("apiKeyScreen.title")}
        </h1>
        <p className="mt-3 text-body-medium-lighter text-[var(--content-tertiary)]">
          {t("apiKeyScreen.body")}
        </p>

        <div className="mt-10 flex w-full flex-col gap-4 text-left">
          <div className="flex flex-col gap-1">
            <label className="text-body-small-default text-[var(--content-tertiary)]">
              {t("apiKeyScreen.providerLabel")}
            </label>
            <Select
              aria-label={t("apiKeyScreen.providerLabel")}
              value={provider}
              onChange={(v) => {
                const match = onboardingProvider(v);
                if (match) {
                  setProvider(match.id);
                  setApiKey("");
                  setModel(defaultModelForOnboardingProvider(match.id) ?? "");
                }
              }}
              options={ONBOARDING_PROVIDERS.map((p) => ({
                value: p.id,
                label: p.displayName,
              }))}
            />
          </div>

          {models.length > 0 && (
            <div className="flex flex-col gap-1">
              <label className="text-body-small-default text-[var(--content-tertiary)]">
                {t("apiKeyScreen.modelLabel")}
              </label>
              <Select
                aria-label={t("apiKeyScreen.modelLabel")}
                value={model}
                onChange={setModel}
                options={models.map((option) => ({
                  value: option.id,
                  label: option.displayName,
                }))}
              />
            </div>
          )}

          {isOpenAICompatible && (
            <>
              <div className="flex flex-col gap-1">
                <label className="text-body-small-default text-[var(--content-tertiary)]">
                  {t("apiKeyScreen.baseUrlLabel")}
                </label>
                <Input
                  type="text"
                  placeholder="http://localhost:1234/v1"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  fullWidth
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-body-small-default text-[var(--content-tertiary)]">
                  {t("apiKeyScreen.modelsLabel")}
                </label>
                <Input
                  type="text"
                  placeholder={t("apiKeyScreen.modelsPlaceholder")}
                  value={customModels}
                  onChange={(e) => setCustomModels(e.target.value)}
                  fullWidth
                />
                <p className="text-body-small-lighter text-[var(--content-tertiary)]">
                  {t("apiKeyScreen.modelsHelp")}
                </p>
              </div>
            </>
          )}

          {requiresKey && (
            <div className="flex flex-col gap-3">
              <Input
                type="password"
                label={t("apiKeyScreen.apiKeyLabel", {
                  provider: entry.displayName,
                })}
                placeholder={
                  entry.apiKeyPlaceholder ?? t("apiKeyScreen.apiKeyPlaceholder")
                }
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                className={MOBILE_INPUT_NO_ZOOM}
                fullWidth
              />
              {entry.docsUrl && (
                <p className="self-start text-body-medium-lighter text-[var(--content-tertiary)]">
                  {t("apiKeyScreen.noKeyPrompt")}{" "}
                  <ExternalAnchor
                    href={entry.docsUrl}
                    tone="quiet"
                    className="text-[var(--content-default)]"
                    glyph={false}
                  >
                    {t("apiKeyScreen.getKeyLink")}
                  </ExternalAnchor>
                </p>
              )}
            </div>
          )}
        </div>

        <div className="mt-8 flex w-full flex-col gap-2">
          <Button
            variant="primary"
            size="large"
            fullWidth
            disabled={!canContinue}
            onClick={onContinue}
          >
            {t("actions.continue")}
          </Button>
          <Button variant="outlined" size="large" fullWidth onClick={onBack}>
            {t("actions.back")}
          </Button>
        </div>
      </div>
    </AccountShell>
  );
}
