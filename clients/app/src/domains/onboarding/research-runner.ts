/**
 * Runs the "research me" turn against the hatched assistant from inside the
 * research-onboarding route and surfaces the parsed `{ claims, suggestions }`
 * incrementally so the in-flow result steps can render real data.
 *
 * SPIKE — research-onboarding flow.
 *
 * Why this lives here (and not in the chat domain): the new in-flow result
 * steps render the research output WITH the toned backdrop, never handing off
 * to the chat surface until the user picks a suggestion. So we fire the turn
 * ourselves — mint a dedicated side conversation, post the research prompt, and
 * poll `listAssistantMessages` — rather than relying on `ActiveChatView`'s
 * stream. Talks to the daemon through the app's scoped gateway client
 * (`@app/gateway/daemon`) — the single-origin relative `/v1` surface, the same
 * one the cloud and desktop hosts resolve server-side. The parser is shared
 * via the neutral `@web/utils/research-facts`.
 *
 * Best-effort: a failure never blocks the flow — the steps just fall back to
 * their loading/empty presentation. The research conversation is intentionally
 * SEPARATE from the user-facing chat the suggestion click later opens.
 */

import { useCallback, useRef, useState } from "react";

import { useQueryClient } from "@tanstack/react-query";

import {
  createAssistantConversation,
  installAssistantPlugin,
  listAssistantMessages,
  postAssistantMessage,
  searchAssistantPlugins,
} from "@app/gateway/daemon";
import { archiveResearchConversation } from "./archive-research-conversation";
import { invalidateConversationQueries } from "@web/utils/conversation-cache";
import type { PluginsSearchGetResponses } from "@web/generated/daemon/types.gen";
import { captureError } from "@mycadet/design-library/utils/capture-error";
import { buildSideConversationMessageBody } from "@web/lib/side-conversation-message";
import { latestAssistantText } from "@web/utils/latest-assistant-text";
import {
  buildResearchPrompt,
  type AvailableCapability,
  type ResearchSubject,
} from "./research-prompt";
import { resolveDeterministicPlugins } from "./onboarding-plugin-affinity";
import {
  parseResearchResultStreaming,
  type ResearchFact,
  type ResearchSuggestion,
} from "@web/utils/research-facts";

/** Poll cadence for reading the streaming research reply. */
const POLL_INTERVAL_MS = 1500;
/**
 * Wall-clock budget for a research turn, measured from `start()`. Covers the
 * hatch wait, catalog fetch, conversation setup, and reply poll. On expiry the
 * run settles `error` and the flow continues with whatever was parsed (often
 * nothing), so the looking-you-up step cannot hold a user for minutes.
 */
export const MAX_RESEARCH_WAIT_MS = 45_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

type ResearchDeadlineResult<T> =
  | { timedOut: true }
  | { timedOut: false; value: T };

async function raceResearchDeadline<T>(
  promise: Promise<T>,
  deadline: number,
): Promise<ResearchDeadlineResult<T>> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    return { timedOut: true };
  }
  return Promise.race([
    promise.then((value): ResearchDeadlineResult<T> => {
      return { timedOut: false, value };
    }),
    sleep(remaining).then((): ResearchDeadlineResult<T> => {
      return { timedOut: true };
    }),
  ]);
}

/**
 * Consecutive identical non-empty reads that mark the turn settled once the
 * reply has parsed as a COMPLETE JSON payload. Two matching polls (~3s apart)
 * means generation has stopped, whether the daemon persists the assistant
 * message incrementally or only on completion.
 */
const STABLE_READS_TO_SETTLE = 2;

export function shouldSettleResearchPoll({
  complete,
  stableReads,
}: {
  complete: boolean;
  stableReads: number;
}): boolean {
  return complete && stableReads >= STABLE_READS_TO_SETTLE;
}

export function resolveResearchCompletionStatus({
  sawCompletePayload,
}: {
  sawCompletePayload: boolean;
}): ResearchStatus {
  return sawCompletePayload ? "done" : "error";
}

/**
 * Org that owns first-party, reviewed Cadet plugins. Onboarding only ever
 * surfaces and installs plugins from this owner — never third-party/external
 * marketplace repos — so a new user is never offered (or silently handed)
 * community code during onboarding.
 */
const CADET_PLUGIN_OWNER = "cadet-ai";

/**
 * Cadet-hosted plugins that are still infrastructure/meta rather than a
 * capability worth offering a new user (a reference memory sample, the
 * self-edit diff card). Dropped on top of the owner filter. Anything else owned
 * by Cadet — including future persona plugins like a developer/PM kit — flows
 * through automatically.
 */
const NON_RECOMMENDABLE_PLUGINS = new Set<string>([
  "simple-memory",
  "level-up",
]);

type CatalogMatch = NonNullable<
  PluginsSearchGetResponses[200]["matches"]
>[number];

export interface RecommendableCapabilities {
  capabilities: AvailableCapability[];
  /** Valid install names, used to gate background installs against hallucination. */
  validNames: Set<string>;
}

/** Keep injected descriptions to one short clause so the prompt stays compact. */
function compactDescription(raw: string): string {
  const firstSentence =
    raw
      .trim()
      .split(/(?<=\.)\s/)[0]
      ?.trim() ?? raw.trim();
  return firstSentence.length > 100
    ? `${firstSentence.slice(0, 97).trimEnd()}…`
    : firstSentence;
}

/** Owner segment of an `owner/repo` locator, or "" when unparseable. */
function repoOwner(repo: string | undefined): string {
  return repo?.split("/")[0]?.trim() ?? "";
}

/**
 * Narrow the marketplace catalog to the capabilities onboarding will surface:
 * Cadet-hosted (first-party, reviewed) plugins only, minus the meta/infra
 * ones, each compacted to one short line. Pure so it's unit-testable without
 * mocking the catalog fetch.
 */
export function selectRecommendableCapabilities(
  matches: CatalogMatch[],
): RecommendableCapabilities {
  const capabilities: AvailableCapability[] = [];
  const validNames = new Set<string>();
  for (const m of matches) {
    const name = m.name?.trim();
    const description = m.description?.trim();
    if (!name || !description) {
      continue;
    }
    if (
      m.source?.kind !== "github" ||
      repoOwner(m.source.repo) !== CADET_PLUGIN_OWNER
    ) {
      continue;
    }
    if (NON_RECOMMENDABLE_PLUGINS.has(name)) {
      continue;
    }
    validNames.add(name);
    capabilities.push({ name, description: compactDescription(description) });
  }
  return { capabilities, validNames };
}

/**
 * Pull the live marketplace catalog and compact it into the first-party
 * capability list the research prompt advertises. Best-effort: any failure
 * yields an empty list, in which case the prompt simply omits the capabilities
 * block.
 */
async function fetchAvailableCapabilities(
  assistantId: string,
): Promise<RecommendableCapabilities> {
  try {
    const res = await searchAssistantPlugins(assistantId);
    return selectRecommendableCapabilities(res.ok ? res.data.matches : []);
  } catch (err) {
    captureError(err, { context: "research_onboarding_catalog" });
    return { capabilities: [], validNames: new Set<string>() };
  }
}

/**
 * Materialize a matched plugin under the assistant's workspace so the fresh
 * conversation the suggestion click opens can discover its skills (plugin-
 * resident skills load per-conversation from disk — no restart needed; the
 * plugin's hooks/persona would need a later restart, but the skills carry the
 * value). Best-effort and idempotent: an already-installed plugin returns 409,
 * which we ignore.
 */
async function installCapabilityBestEffort(
  assistantId: string,
  name: string,
): Promise<void> {
  try {
    await installAssistantPlugin(assistantId, name);
  } catch (err) {
    captureError(err, { context: "research_onboarding_install" });
  }
}

/**
 * Cap on hobbies reported to telemetry. Matches the cloud serializer's
 * `self_reported_hobbies` bound so the two can't disagree.
 */

/** Count claims in one confidence tier — mirrors the derived wire counts. */

export type ResearchStatus = "idle" | "running" | "done" | "error";

export interface ResearchRunnerState {
  status: ResearchStatus;
  claims: ResearchFact[];
  /**
   * Claim texts the parser dropped from `claims` because every source was a
   * people-search aggregator. Carried so the onboarding flow can scrub these
   * hidden wrong-person facts from the assistant's memory alongside the ones the
   * user prunes on the card.
   */
  droppedClaims: string[];
  suggestions: ResearchSuggestion[];
  /**
   * Capabilities being installed for the assistant this run — the deterministic
   * floor (always-install baseline + role affinity) unioned with the model's
   * top-level `plugins` picks, each narrowed to names present in the fetched
   * catalog. Persona-level (not tied to a suggestion); surfaced so the UI can
   * confirm what was set up. Empty when the first-party catalog is unavailable
   * or nothing fit.
   */
  installedPlugins: string[];
}

function emptyResearchState(status: ResearchStatus): ResearchRunnerState {
  return {
    status,
    claims: [],
    droppedClaims: [],
    suggestions: [],
    installedPlugins: [],
  };
}

export interface StartResearchOptions {
  /** Resolves with the hatched assistant id once it's healthy. */
  awaitAssistantId: () => Promise<string>;
  subject: ResearchSubject;
  /** Friendly title for the behind-the-scenes research conversation. */
  conversationTitle?: string;
  /**
   * Resume a research conversation a prior session minted (a refresh mid-search)
   * instead of creating a fresh one. The prior turn keeps generating server-side
   * across the reload, so we re-attach and poll it — re-posting the prompt only
   * if it never landed before the refresh — so the search is never run twice. If
   * the conversation is gone (e.g. it completed and was archived), falls back to
   * a fresh run so the user still gets results.
   */
  resumeConversationId?: string;
  /**
   * Invoked with the conversation id the moment a FRESH research conversation is
   * minted (not on resume), so the caller can persist it and resume this exact
   * thread if the page is refreshed mid-search.
   */
  onConversationCreated?: (conversationId: string) => void;
  /**
   * Whether to ask the model for clickable `suggestions`. Off for the "Let's
   * chat" final step (now always on), which installs the picked
   * plugins and primes a chat instead of surfacing suggestion cards. Defaults to
   * true so the legacy suggestions flow is unchanged.
   */
  includeSuggestions?: boolean;
  /**
   * Wall-clock budget for this run. Defaults to `MAX_RESEARCH_WAIT_MS`. Tests
   * pass a shorter value so a hung hatch or poll fails open without waiting
   * the production ceiling.
   */
  timeoutMs?: number;
}

export interface UseResearchRunner extends ResearchRunnerState {
  /**
   * Fire the research turn. Keyed by subject: calling again with the same
   * subject is a no-op, but resubmitting with EDITED details (e.g. the user
   * stepped back and changed their name/role) restarts the run and cancels the
   * stale poll loop so the results reflect the corrected subject.
   */
  start: (options: StartResearchOptions) => void;
  /**
   * Block a suggestion click only as long as the persona plugins need: waits for
   * the `plugins` decision to be final (so a click that beat the parse doesn't
   * skip selection), then for those installs to finish — never for the rest of
   * the research turn. Resolves instantly when nothing is installable (empty
   * catalog, none picked, or already installed), so ordinary clicks don't hang.
   */
  awaitPluginInstalls: () => Promise<void>;
  /**
   * Adopt research output persisted by a prior session (a page refresh) as the
   * settled state, WITHOUT re-running the turn — so a refresh that resumes past
   * a completed search never fires a second "research me" background turn.
   *
   * The plugin installs are best-effort and fire-and-forget, so a refresh can
   * cancel ones that hadn't settled, leaving capabilities the UI claims were set
   * up not actually installed. So when `awaitAssistantId` is supplied, re-enqueue
   * an install for each named plugin (idempotent — an already-installed plugin
   * 409s and is ignored) and track its promise, so `awaitPluginInstalls` blocks a
   * suggestion click until the capabilities are genuinely present again.
   */
  hydrate: (
    results: ResearchRunnerState,
    awaitAssistantId?: () => Promise<string>,
  ) => void;
  /**
   * Re-enqueue installs for `names` against a fresh assistant promise, replacing
   * whatever the run is tracking. For a settled run whose installs raced a hatch
   * that then died: each one swallowed the rejection and resolved without
   * installing anything while the run stayed `done`, so `awaitPluginInstalls`
   * lets the handoff through on capabilities that aren't there. Idempotent and
   * best-effort, like every other install path.
   */
  reinstallPlugins: (
    names: string[],
    awaitAssistantId: () => Promise<string>,
  ) => void;
  /**
   * Drop the run's subject key and results so a following `start` with the SAME
   * subject re-fires instead of deduping to a no-op. For restarting a turn that
   * died with the dependency it was waiting on — a failed hatch rejects
   * `awaitAssistantId` and settles the run "error" while it keeps holding the
   * key — not for ordinary resubmits, which the key is there to collapse.
   */
  reset: () => void;
}

export function resolveOnboardingPluginInstalls({
  role,
  validNames,
  modelPlugins,
}: {
  role: string;
  validNames: Set<string>;
  modelPlugins: readonly string[];
}): string[] {
  return [
    ...new Set([
      ...resolveDeterministicPlugins(role, validNames),
      ...modelPlugins.filter((name) => validNames.has(name)),
    ]),
  ];
}

export function useResearchRunner(): UseResearchRunner {
  const [state, setState] = useState<ResearchRunnerState>(() =>
    emptyResearchState("idle"),
  );
  // Monotonic run id: every fresh run claims the next id; in-flight loops bail
  // the moment a newer run supersedes them. Paired with the last subject key so
  // an identical resubmit is a no-op but an edited one restarts.
  const runIdRef = useRef(0);
  const subjectKeyRef = useRef<string | null>(null);
  // Background plugin installs keyed by name, so the suggestion click can await
  // them all before opening the chat (see `awaitPluginInstalls`). Promises stay
  // resolved in the map, so awaiting a settled one is instant.
  const installPromisesRef = useRef<Map<string, Promise<void>>>(new Map());
  // Resolves once the `plugins` DECISION is final for the current run — the
  // model's array has closed (installs, if any, enqueued), or there was nothing
  // installable, or the run ended. The suggestion click awaits this BEFORE the
  // installs, so a click that beats the parse still can't open the chat on an
  // empty install map — yet it does NOT wait on the rest of the research turn,
  // so ordinary clicks (plugins disabled / none picked / already installed)
  // aren't frozen until the whole reply settles.
  const pluginsReadyRef = useRef<Promise<void>>(Promise.resolve());
  const queryClient = useQueryClient();

  // Track an install per name against a hatch promise, replacing the map. Used
  // by both the resume hydrate and a post-retry re-enqueue, so the click gate
  // always awaits installs bound to the CURRENT hatch attempt.
  const enqueuePluginInstalls = useCallback(
    (names: string[], awaitAssistantId: () => Promise<string>) => {
      const installs = installPromisesRef.current;
      installs.clear();
      for (const name of names) {
        installs.set(
          name,
          (async () => {
            try {
              const assistantId = await awaitAssistantId();
              await installCapabilityBestEffort(assistantId, name);
            } catch {
              // Hatch never readied / install failed — don't block the click.
            }
          })(),
        );
      }
    },
    [],
  );

  const start = useCallback(
    ({
      awaitAssistantId,
      subject,
      conversationTitle,
      resumeConversationId,
      onConversationCreated,
      includeSuggestions = true,
      timeoutMs = MAX_RESEARCH_WAIT_MS,
    }: StartResearchOptions) => {
      const subjectKey = JSON.stringify(subject);
      if (subjectKeyRef.current === subjectKey) {
        return;
      }
      subjectKeyRef.current = subjectKey;
      const runId = runIdRef.current + 1;
      runIdRef.current = runId;
      const isStale = () => runIdRef.current !== runId;
      // Fresh run — drop installs tracked for a superseded subject, and arm a new
      // plugins-ready latch the click can await (resolved once the plugin
      // decision is final; the `finally` is the backstop on every exit path).
      let resolvePluginsReady: () => void = () => {};
      pluginsReadyRef.current = new Promise<void>((res) => {
        resolvePluginsReady = res;
      });
      installPromisesRef.current.clear();
      setState(emptyResearchState("running"));

      void (async () => {
        let resolvedAssistantId: string | undefined;
        let createdConversationId: string | undefined;
        let sawCompletePayload = false;
        const deadline = Date.now() + timeoutMs;
        const settleTimeout = () => {
          if (isStale()) {
            return;
          }
          setState((s) => ({ ...s, status: "error" }));
        };
        try {
          const hatchResult = await raceResearchDeadline(
            awaitAssistantId(),
            deadline,
          );
          if (hatchResult.timedOut) {
            settleTimeout();
            return;
          }
          const assistantId = hatchResult.value;
          resolvedAssistantId = assistantId;
          if (isStale()) {
            return;
          }

          // Advertise the Cadet-owned marketplace capabilities to the research
          // turn so it can pick the ones that best fit the person (returned as a
          // top-level `plugins` list) for us to install. The catalog filter keeps
          // onboarding scoped to first-party plugins; third-party plugin
          // browsing/install surfaces remain independently feature-gated.
          const catalogResult = await raceResearchDeadline(
            fetchAvailableCapabilities(assistantId),
            deadline,
          );
          if (catalogResult.timedOut) {
            settleTimeout();
            return;
          }
          const { capabilities, validNames } = catalogResult.value;
          if (isStale()) {
            return;
          }
          // Nothing installable (empty/unavailable catalog) — release the click
          // gate so suggestion clicks never wait on the research turn.
          if (validNames.size === 0) {
            resolvePluginsReady();
          }

          // Tracks every install fired this run (deterministic floor + the model's
          // later picks), keyed by name so the suggestion click can await them and
          // a name is never installed twice.
          const installs = installPromisesRef.current;
          // Deterministic floor: the always-install baseline plus any
          // marketing-attributed pick (the plugin the user clicked "Install" on
          // before onboarding — resolved inside `resolveDeterministicPlugins`)
          // plus the role's affinity matches, narrowed to the live catalog.
          // Fired here — right after the catalog fetch, before the model has
          // replied — so these materialize while the research turn is still
          // streaming. The model's `plugins` picks (handled in the poll loop)
          // union on top for the long tail of roles this map doesn't enumerate.
          const deterministicPlugins = resolveDeterministicPlugins(
            subject.occupation,
            validNames,
          );
          for (const name of deterministicPlugins) {
            if (!installs.has(name)) {
              installs.set(
                name,
                installCapabilityBestEffort(assistantId, name),
              );
            }
          }
          if (deterministicPlugins.length > 0) {
            setState((s) => ({ ...s, installedPlugins: deterministicPlugins }));
          }

          // Post the research prompt onto a conversation. Returns false on a
          // failed POST so the caller can settle "error".
          const postResearchPrompt = async (cid: string): Promise<boolean> => {
            const body = buildSideConversationMessageBody({
              conversationId: cid,
              content: buildResearchPrompt(subject, capabilities, {
                includeSuggestions,
              }),
              transport: "web",
            });
            // Carry the browser timezone so any time-relative reasoning resolves
            // to the user's local clock. Mirrors `checkin-scheduler.ts`.
            try {
              const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
              if (tz) {
                body.clientTimezone = tz;
              }
            } catch {
              // Intl unavailable — daemon falls back to its own cascade.
            }
            const posted = await postAssistantMessage(assistantId, body);
            return posted.ok;
          };

          // Mint a fresh research conversation + fire the prompt. Used for the
          // initial run and as the resume fallback when the prior conversation
          // is gone.
          const startFreshConversation = async (): Promise<
            string | undefined
          > => {
            // `background` creates the row outside the daemon's default
            // `standard` list, so it never appears in Recents and can never be
            // selected as the landing conversation.
            const conversation = await createAssistantConversation(
              assistantId,
              {
                conversationType: "background",
                ...(conversationTitle ? { title: conversationTitle } : {}),
              },
            );
            // Capture before the stale check so the finally block can archive
            // it on every exit path.
            createdConversationId = conversation.ok ? conversation.data.id : undefined;
            const id = createdConversationId;
            if (!conversation.ok || !id) {
              return undefined;
            }
            // A deadline race does not cancel createAssistantConversation. If this run
            // already gave up (or a newer one superseded it), archive here so
            // the row is not left behind after finally has already run, and
            // do not persist a resume id for a search that will not continue.
            if (isStale() || Date.now() >= deadline) {
              await archiveResearchConversation(assistantId, id);
              return undefined;
            }
            // Surface the new id immediately so the caller can persist it and
            // resume this exact thread across a refresh.
            onConversationCreated?.(id);
            return id;
          };

          let conversationId: string | undefined;
          if (resumeConversationId) {
            // Resume the prior session's research conversation rather than
            // running a second search. The turn keeps generating server-side
            // across the reload, so re-attach and poll it; only re-post the
            // prompt if it never landed before the refresh.
            const existing = await raceResearchDeadline(
              listAssistantMessages(assistantId, resumeConversationId),
              deadline,
            );
            if (existing.timedOut) {
              settleTimeout();
              return;
            }
            if (isStale()) {
              return;
            }
            if (existing.value.ok) {
              conversationId = resumeConversationId;
              createdConversationId = resumeConversationId;
              // The hidden prompt row is filtered out of `/messages`, so a
              // started turn shows as the daemon still processing or as a row
              // it has already produced, never as a user message.
              const turnAlreadyStarted =
                existing.value.data?.processing === true ||
                (existing.value.data?.messages ?? []).length > 0;
              if (!turnAlreadyStarted) {
                const posted = await raceResearchDeadline(
                  postResearchPrompt(conversationId),
                  deadline,
                );
                if (posted.timedOut) {
                  settleTimeout();
                  return;
                }
                if (!posted.value) {
                  setState((s) => ({ ...s, status: "error" }));
                  return;
                }
                if (isStale()) {
                  return;
                }
              }
            }
            // Not ok → conversation gone (e.g. completed + archived); fall
            // through to a fresh run below.
          }

          if (!conversationId) {
            const minted = await raceResearchDeadline(
              startFreshConversation(),
              deadline,
            );
            if (minted.timedOut) {
              settleTimeout();
              return;
            }
            conversationId = minted.value;
            if (isStale()) {
              return;
            }
            if (!conversationId) {
              setState((s) => ({ ...s, status: "error" }));
              return;
            }
            const posted = await raceResearchDeadline(
              postResearchPrompt(conversationId),
              deadline,
            );
            if (posted.timedOut) {
              settleTimeout();
              return;
            }
            if (!posted.value) {
              setState((s) => ({ ...s, status: "error" }));
              return;
            }
            if (isStale()) {
              return;
            }
          }

          // Poll the conversation, parsing the (possibly partial) reply each
          // pass so claims/suggestions surface as they land. Settle once the
          // reply text stops changing, or when the overall research budget
          // expires.
          let lastText = "";
          let stableReads = 0;
          // Guards the telemetry report to fire exactly once: `complete` can
          // stay true across the `STABLE_READS_TO_SETTLE` re-polls before the
          // loop breaks, and would otherwise re-send on every one of them.
          // The model's `plugins` picks fire as soon as its array closes — emitted
          // first in the reply, so this lands early while claims/suggestions are
          // still streaming. These union on top of the deterministic floor already
          // installing (see above); idempotent, so racing the same name is fine.
          while (Date.now() < deadline) {
            const waitMs = Math.min(
              POLL_INTERVAL_MS,
              Math.max(0, deadline - Date.now()),
            );
            if (waitMs === 0) {
              break;
            }
            await sleep(waitMs);
            if (isStale()) {
              return;
            }
            if (Date.now() >= deadline) {
              break;
            }
            const listed = await raceResearchDeadline(
              listAssistantMessages(assistantId, conversationId),
              deadline,
            );
            if (listed.timedOut) {
              break;
            }
            if (isStale()) {
              return;
            }
            const messages = listed.value.ok
              ? listed.value.data.messages
              : [];
            const text = latestAssistantText(messages);
            if (text) {
              const {
                claims,
                droppedClaims,
                suggestions,
                plugins,
                pluginsResolved,
                complete,
              } = parseResearchResultStreaming(text);
              // Narrow the model's picks to the catalog we actually fetched so a
              // hallucinated name never hits the install route; fire each new one.
              const validPlugins = plugins.filter((name) =>
                validNames.has(name),
              );
              for (const name of validPlugins) {
                if (!installs.has(name)) {
                  installs.set(
                    name,
                    installCapabilityBestEffort(assistantId, name),
                  );
                }
              }
              // Once the plugin decision is final (array closed, even if empty),
              // the install set is complete — release the click gate so it waits
              // only on the installs themselves, not the rest of the turn.
              if (pluginsResolved) {
                resolvePluginsReady();
              }
              // Surface the full set actually installing: the deterministic
              // floor plus the model's picks, deduped, baseline first. Shared
              // by the state update and the telemetry report below so it's
              // only computed once per poll.
              const installedPlugins = resolveOnboardingPluginInstalls({
                role: subject.occupation,
                validNames,
                modelPlugins: validPlugins,
              });
              setState({
                status: "running",
                claims,
                droppedClaims,
                suggestions,
                installedPlugins,
              });
              if (complete) {
                sawCompletePayload = true;
              }
              stableReads = text === lastText ? stableReads + 1 : 0;
              lastText = text;
              // Only a complete payload can settle early. A partial JSON object
              // can pause between claim/suggestion objects for long enough to
              // look stable, but it may still be mid-response.
              if (shouldSettleResearchPoll({ complete, stableReads })) {
                break;
              }
            }
          }

          if (isStale()) {
            return;
          }
          setState((s) => ({
            ...s,
            status: resolveResearchCompletionStatus({ sawCompletePayload }),
          }));
        } catch (err) {
          if (isStale()) {
            return;
          }
          captureError(err, { context: "research_onboarding_runner" });
          setState((s) => ({ ...s, status: "error" }));
        } finally {
          // Backstop: release the click gate on every exit path (done, error, or
          // a stale bail-out, or a reply that never emitted a `plugins` array) so
          // `awaitPluginInstalls` can never hang.
          resolvePluginsReady();
          // Unconditional cleanup: a timed-out or superseded run must not leave
          // the throwaway side conversation behind.
          if (resolvedAssistantId && createdConversationId) {
            await archiveResearchConversation(
              resolvedAssistantId,
              createdConversationId,
            );
            void invalidateConversationQueries(
              queryClient,
              resolvedAssistantId,
            );
          }
        }
      })();
    },
    [queryClient],
  );

  const reset = useCallback(() => {
    // Supersede any in-flight loop, release the subject key so an identical
    // resubmit is treated as a genuinely fresh run, and re-arm an already-
    // resolved click gate so `awaitPluginInstalls` can't hang on a run that no
    // longer exists.
    runIdRef.current += 1;
    subjectKeyRef.current = null;
    installPromisesRef.current.clear();
    pluginsReadyRef.current = Promise.resolve();
    setState(emptyResearchState("idle"));
  }, []);

  const awaitPluginInstalls = useCallback(async (): Promise<void> => {
    // Wait only for the plugin decision to be final (so a click that beats the
    // parse doesn't await an empty map), then for those installs — never for the
    // rest of the research turn. Resolves instantly when nothing is installable.
    await pluginsReadyRef.current;
    await Promise.all([...installPromisesRef.current.values()]);
  }, []);

  const hydrate = useCallback(
    (
      results: ResearchRunnerState,
      awaitAssistantId?: () => Promise<string>,
    ) => {
      // Supersede any in-flight run: bump the id so its loop bails, drop its
      // subject key so a later start of that same subject is not treated as a
      // duplicate, and release the plugin click-gate so a skip/resume cannot
      // stay blocked on the abandoned turn's installs.
      runIdRef.current += 1;
      subjectKeyRef.current = null;
      installPromisesRef.current.clear();
      pluginsReadyRef.current = Promise.resolve();
      setState(results);

      // Re-enqueue the named installs against the (re-)hatched assistant so a
      // suggestion click awaits real promises rather than an empty map. Idempotent
      // and best-effort: a failed hatch / install never blocks the click.
      if (awaitAssistantId && results.installedPlugins.length > 0) {
        enqueuePluginInstalls(results.installedPlugins, awaitAssistantId);
      }
    },
    [enqueuePluginInstalls],
  );

  return {
    ...state,
    start,
    awaitPluginInstalls,
    hydrate,
    reinstallPlugins: enqueuePluginInstalls,
    reset,
  };
}
