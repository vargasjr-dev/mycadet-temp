import { useState } from "react";

import { Disclosure } from "@mycadet/design-library/components/disclosure";
import { Input, Textarea } from "@mycadet/design-library/components/input";
import { Toggle } from "@mycadet/design-library/components/toggle";
import { Typography } from "@mycadet/design-library/components/typography";

import { ProfileAdvancedParams } from "@/domains/settings/ai/profile-advanced-params";
import { ProfileCreateModelFirst } from "@/domains/settings/ai/profile-create-model-first";
import { ProfileEditorProviderSection } from "@/domains/settings/ai/profile-editor-provider-section";
import { ProfileModalitiesSection } from "@/domains/settings/ai/profile-modalities-section";
import { profileUsesFreeTextModel } from "@/domains/settings/ai/profile-modalities";
import type { ProfileEditor } from "@/domains/settings/ai/use-profile-editor";
import { useTranslation, Trans } from "@/i18n";
import type { ProviderConnection } from "@/generated/daemon/types.gen";
import { useSupportsProfileInputModalities } from "@/lib/backwards-compat/profile-input-modalities";


export interface ProfileEditorFieldsProps {
  editor: ProfileEditor;
  assistantId: string;
  /** Raw host-supplied connections (see ProfileEditorModalProps.connections). */
  connections: ProviderConnection[] | undefined;
  /**
   * Host chrome the fields render into:
   * - `"modal"`: the modal layouts - create keeps Description, Name and the
   *   advanced params behind a collapsed Advanced disclosure.
   * - `"panel"`: the settings sidepanel (Figma 7412:134288) - every field
   *   is flat and always visible.
   */
  variant: "modal" | "panel";
  /**
   * Box the model-first create flow keeps its open list inside, and which it
   * then keeps tall enough to hold it. The modal host passes its own body;
   * the sidepanel is already full height and passes nothing.
   */
  menuBoundary?: Element | null;
}

/**
 * The profile editor's field stack, shared by the modal host (composer
 * quick-add) and the settings sidepanel. All state lives in the
 * `useProfileEditor` hook; this component only arranges fields per
 * mode/variant.
 *
 * Creating a profile asks two questions: which provider, and which model.
 * Everything the model can answer for itself - the Name, and the parameters
 * that model supports - sits under Advanced for the minority who want to
 * change it. The Key is not asked at all: it is always the slug of the Name.
 * Enabling and disabling is not asked either; a new profile is active, and the
 * row's kebab menu turns one off later.
 */
export function ProfileEditorFields({
  editor,
  assistantId,
  connections,
  variant,
  menuBoundary,
}: ProfileEditorFieldsProps) {
  const { t } = useTranslation("settings");
  const isCreate = editor.effectiveMode === "create";
  const flat = variant === "panel";
  const supportsInputModalities = useSupportsProfileInputModalities();

  // Create-mode Advanced disclosure (modal variant only). Local state is
  // fine: hosts remount the fields on each open, matching the old reset.
  const [advancedExpanded, setAdvancedExpanded] = useState(false);
  const [modalitiesExpanded, setModalitiesExpanded] = useState(false);
  // The Name lives under Advanced, so a Name the user has to fix cannot be
  // left hidden behind a collapsed disclosure.
  const createAdvancedOpen = advancedExpanded || Boolean(editor.nameError);
  const showModalities =
    supportsInputModalities &&
    profileUsesFreeTextModel(editor.provider, editor.model);

  const modalitiesNode = showModalities ? (
    <ProfileModalitiesSection
      value={editor.inputModalities}
      onChange={editor.setInputModalities}
      isReadOnly={editor.isReadOnly}
      expanded={flat || modalitiesExpanded}
      onExpandedChange={setModalitiesExpanded}
      collapsible={!flat}
    />
  ) : null;

  const displayNameField = (
    <div className="space-y-1">
      <label className="block text-body-small-default text-[var(--content-tertiary)]">
        {isCreate
          ? t("profileEditorFields.nameLabel")
          : t("profileEditorFields.displayNameLabel")}
      </label>
      <Input
        type="text"
        value={editor.label}
        onChange={(e) => editor.handleLabelChange(e.target.value)}
        onBlur={editor.handleLabelBlur}
        placeholder={t("profileEditorFields.displayNamePlaceholder")}
        disabled={editor.isReadOnly}
        errorText={editor.isReadOnly ? undefined : editor.nameError}
        fullWidth
      />
    </div>
  );

  const descriptionField = (
    <Textarea
      label={
        <Trans
          i18nKey="profileEditorFields.descriptionLabel"
          ns="settings"
          components={{
            optional: <span className="text-[var(--content-disabled)]" />,
          }}
        />
      }
      value={editor.description}
      onChange={(e) => editor.setDescription(e.target.value)}
      placeholder={t("profileEditorFields.descriptionPlaceholder")}
      disabled={editor.isReadOnly}
      rows={2}
      fullWidth
      className="resize-none"
    />
  );

  // Enabling and disabling a profile the user owns lives on its row's kebab
  // menu, so the editor does not ask: a new profile is active, and an existing
  // one keeps whatever the row set. The one case the row cannot serve is a
  // cloud profile opened read-only and already disabled, where this
  // enable-only toggle is the whole reason the form can be saved at all. The
  // panel variant never shows it - it reaches cloud profiles through
  // "Save As New".
  const activeToggle =
    !flat && editor.isReadOnly && editor.status === "disabled" ? (
      <Toggle
        // Enable-only: the flip is what arms Save, and it unmounts the toggle
        // with it, because a cloud profile cannot be disabled from here.
        checked={false}
        onChange={() => editor.setStatus("active")}
        label={t("profileEditorFields.activeLabel")}
        className="touch-mobile:mt-2 touch-mobile:[&_button]:h-7 touch-mobile:[&_button]:w-10 touch-mobile:[&_button>span]:h-6 touch-mobile:[&_button>span]:w-6"
      />
    ) : null;

  const advancedParamsNode = (
    <ProfileAdvancedParams
      visibility={editor.visibility}
      isReadOnly={editor.isReadOnly}
      model={editor.model}
      selectedModel={editor.selectedModel}
      defaultMaxOutputTokens={editor.defaultMaxOutputTokens}
      defaultContextWindowMaxInputTokens={
        editor.defaultContextWindowMaxInputTokens
      }
      maxTokens={editor.maxTokens}
      onMaxTokensChange={editor.setMaxTokens}
      contextWindowMaxInputTokens={editor.contextWindowMaxInputTokens}
      onContextWindowChange={editor.setContextWindowMaxInputTokens}
      effort={editor.effort}
      onEffortChange={editor.setEffort}
      speed={editor.speed}
      onSpeedChange={editor.setSpeed}
      verbosity={editor.verbosity}
      onVerbosityChange={editor.setVerbosity}
      temperatureEnabled={editor.temperatureEnabled}
      onTemperatureEnabledChange={editor.setTemperatureEnabled}
      temperature={editor.temperature}
      onTemperatureChange={editor.setTemperature}
      topPEnabled={editor.topPEnabled}
      onTopPEnabledChange={editor.setTopPEnabled}
      topP={editor.topP}
      onTopPChange={editor.setTopP}
      thinkingEnabled={editor.thinkingEnabled}
      onThinkingEnabledChange={editor.setThinkingEnabled}
      thinkingStreamThinking={editor.thinkingStreamThinking}
      onThinkingStreamThinkingChange={editor.setThinkingStreamThinking}
      thinkingLevel={editor.thinkingLevel}
      onThinkingLevelChange={editor.setThinkingLevel}
    />
  );

  const saveErrorNode = editor.saveError ? (
    <Typography
      variant="body-small-default"
      as="p"
      className="text-(--system-negative-strong)"
    >
      {editor.saveError}
    </Typography>
  ) : null;

  if (isCreate) {
    // Advanced only surfaces once a model is chosen: the Name derives from
    // the model, and the model controls the available advanced parameters.
    const modelChosen = editor.model !== "";
    // Description first, then Name, then the model's parameters. Name sits
    // below Description because the model has already filled it in: it is the
    // field most people scroll past, not the one they came here to set.
    const advancedFields = (
      <>
        {descriptionField}
        {displayNameField}
        {advancedParamsNode}
      </>
    );
    const createAdvanced = flat
      ? modelChosen && <div className="space-y-4">{advancedFields}</div>
      : modelChosen && (
          <Disclosure.Root
            open={createAdvancedOpen}
            // A name error holds the region open over the user's own choice,
            // so a click flips that choice rather than adopting the state
            // the click appears to ask for.
            onOpenChange={() => setAdvancedExpanded((v) => !v)}
          >
            <Disclosure.Trigger fullWidth>
              {t("profileEditorFields.advanced")}
            </Disclosure.Trigger>
            <Disclosure.Content className="mt-4 space-y-4">
              {advancedFields}
            </Disclosure.Content>
          </Disclosure.Root>
        );

    // Create asks two questions: which provider, and which model. Everything
    // else has an answer the model supplies, so it waits under Advanced.
    return (
      <div className="space-y-4">
        <ProfileCreateModelFirst
          editor={editor}
          assistantId={assistantId}
          menuBoundary={menuBoundary}
        />
        {modalitiesNode}
        {createAdvanced}
        {saveErrorNode}
      </div>
    );
  }

  // Edit / view: Display Name -> Description -> Provider -> Model ->
  // always-visible advanced params.
  return (
    <div className="space-y-4">
      {displayNameField}
      {descriptionField}
      {activeToggle}

      <ProfileEditorProviderSection
        provider={editor.provider}
        model={editor.model}
        providerConnection={editor.providerConnection}
        onProviderChange={editor.handleProviderChange}
        onModelChange={editor.handleModelChange}
        onConnectionChange={editor.handleConnectionChange}
        connections={connections}
        isReadOnly={editor.isReadOnly}
        availableConnectionsForProvider={editor.availableConnectionsForProvider}
        connectionNotFound={editor.connectionNotFound}
        providerError={editor.providerError}
      />

      {modalitiesNode}

      {advancedParamsNode}

      {saveErrorNode}
    </div>
  );
}
