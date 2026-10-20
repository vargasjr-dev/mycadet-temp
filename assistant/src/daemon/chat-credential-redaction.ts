/**
 * Chat-persist credential redaction — sentinel markers with proven vault
 * identity (LUM-2768).
 *
 * The legacy persist path replaces detected secrets with a dead
 * `<redacted type="…" />` HTML marker that the chat markdown pipeline (no
 * rehype-raw) can never render as an element, and that carries no way back
 * to the vault entry it came from. This module implements the replacement
 * that replaced the legacy persist path's marker for chat:
 *
 *   1. While a turn runs, every shell-style tool command is scanned for
 *      `credentials reveal` invocations and the referenced credentials
 *      (`--service`/`--field` flags, a positional UUID, or a legacy
 *      `service/field` path) are recorded as
 *      *candidates* ({@link collectRevealRefsFromCommand}).
 *   2. At persist time, only those candidates' plaintexts are fetched from
 *      the credential store — a scoped read of secrets that were already in
 *      daemon memory this turn via the reveal stdout, never a vault scan
 *      ({@link resolveRevealCandidates}).
 *   3. Each redacted span in persisted ASSISTANT TEXT is byte-compared
 *      against the candidate values (tool_result content keeps the legacy
 *      marker until the tool detail panel can render chips — see
 *      `buildToolResultBlocks`).
 *      An exact match *proves* the span is that credential, so the sentinel
 *      is enriched with `service:field` and the client can offer
 *      click-to-reveal. Anything else — hand-typed secrets, parse failures,
 *      value drift — degrades to a plain type-only sentinel that renders as
 *      a static badge ({@link redactSecretsForChat}).
 *
 * Failure direction is the design's spine: a wrong `service:field` would let
 * the client reveal the *wrong* secret, so enrichment only ever happens on
 * exact plaintext equality. Every uncertain path fails toward "badge",
 * never toward "mislabeled chip".
 *
 * The legacy marker path (`redactSecrets`) is untouched — ingress blocking,
 * tool-output scanning, and log redaction depend on its exact shape (see
 * `security/AGENTS.md`). This module is additive and chat-persist-only.
 */

import {
  neutralizeRedactedSentinels,
  REDACTED_SENTINEL_OPEN,
  REDACTED_SENTINEL_TAG,
} from "@mycadet/service-contracts/redacted-credential";

import { revealedValuesSince } from "../runtime/reveal-success-registry.js";
import { credentialKey } from "../security/credential-key.js";
import { redactSecrets, scanText } from "../security/secret-scanner.js";
import { getSecureKeyAsync } from "../security/secure-keys.js";
import { getCredentialMetadataById } from "../tools/credentials/metadata-store.js";
import { parseServiceFieldRef } from "../tools/credentials/ref-parse.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("chat-credential-redaction");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A credential reference parsed from a `credentials reveal` invocation. */
export interface RevealCandidateRef {
  service?: string;
  field?: string;
  /** Opaque credential UUID (positional CLI arg) — resolved to service/field. */
  id?: string;
  /**
   * The plaintext the reveal route served for this ref, captured by
   * {@link filterRefsByRevealProof} at proof time. When present, candidate
   * resolution redacts these EXACT bytes and skips the vault read — so a
   * rotation/deletion between reveal and persist can't make the redacted
   * value diverge from what the tool actually printed. Absent only for refs
   * that were never proven (which resolution drops anyway).
   */
  provenValue?: string;
}

/** A candidate with its plaintext, ready for byte-comparison. */
export interface ResolvedRevealCandidate {
  service: string;
  field: string;
  value: string;
}

// ---------------------------------------------------------------------------
// Command parsing
// ---------------------------------------------------------------------------

/** Matches `credentials reveal` with any CLI entry point (`assistant`, bin
 *  paths, …) — the two words are what identify the subcommand. */
const REVEAL_INVOCATION_RE = /\bcredentials\s+reveal\b/;

// An unquoted flag value ends at whitespace, a quote, or a shell
// metacharacter that can directly abut a word — `()`/backtick (command
// substitution) and `<>` (redirection) — so `--field token)` inside
// `$(… reveal --field token)` parses as `token`, the identity the route
// records proof under. Separators (`|&;`) never reach a segment unescaped;
// the splitter consumed them. A backslash escapes the next character.
const FLAG_VALUE = String.raw`(?:"((?:\\.|[^"\\])*)"|'([^']*)'|((?:\\.|[^\s"'\\()<>\`])+))`;
const SERVICE_FLAG_RE = new RegExp(String.raw`--service(?:=|\s+)${FLAG_VALUE}`);
const FIELD_FLAG_RE = new RegExp(String.raw`--field(?:=|\s+)${FLAG_VALUE}`);
const UUID_RE =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
// The CLI's single positional argument, directly after `reveal`. A UUID is
// handled above; anything else is tried as a legacy `service/field` path via
// the shared grammar in `parseServiceFieldRef`. The route rejects that form
// as an id today, so no plaintext prints; staging the ref is defense in depth
// so a future lookup that does succeed is already proof-gated.
const POSITIONAL_RE = /\breveal\s+([^\s"'\\()<>`-][^\s"'\\()<>`]*)/;

/**
 * Extract a flag's value from a segment, undoing the shell quoting the
 * value arrived with. The shell strips quoting before the CLI sees argv,
 * so the reveal route records proof under the UNESCAPED identity —
 * `--service foo\ bar` must parse to `foo bar` or the staged ref can never
 * match its proof and the reveal's output would bypass the guard and the
 * candidate fallback. Single quotes are literal; a backslash escapes the
 * next character when unquoted, and inside double quotes it escapes only
 * the characters POSIX lets it escape that can appear in an identifier
 * (`"` and `\` — the rest stay literal, matching the shell).
 */
function flagValue(segment: string, re: RegExp): string | undefined {
  const m = re.exec(segment);
  if (!m) {
    return undefined;
  }
  if (m[1] !== undefined) {
    return m[1].replace(/\\(["\\])/g, "$1");
  }
  if (m[2] !== undefined) {
    return m[2];
  }
  return m[3]?.replace(/\\(.)/g, "$1");
}

/**
 * Split a shell command into segments at UNQUOTED separators (`&&`, `||`,
 * `;`, `|`, a lone `&`, newline). A separator inside a quoted flag value —
 * `--service 'R&D'` — is part of the value, and cutting there would orphan
 * the invocation's flags across two broken segments: no ref gets staged,
 * so the reveal's output could stream or persist raw even though the route
 * served it. Minimal POSIX-ish quoting: single quotes are literal to the
 * next single quote, double quotes honor backslash escapes, and a
 * backslash outside quotes escapes the next character. An unterminated
 * quote runs to the end of the string — the remainder stays one segment,
 * which at worst stages nothing (the same safe direction as before).
 * Quotes are kept in the output so the flag regexes see them.
 */
function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let i = 0;
  while (i < command.length) {
    const ch = command[i]!;
    if (quote === "'") {
      current += ch;
      if (ch === "'") {
        quote = undefined;
      }
      i += 1;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\" && i + 1 < command.length) {
        current += ch + command[i + 1];
        i += 2;
        continue;
      }
      current += ch;
      if (ch === '"') {
        quote = undefined;
      }
      i += 1;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      current += ch + command[i + 1];
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      i += 1;
      continue;
    }
    if (ch === "&" || ch === "|") {
      // `&&`/`||` consume both characters so the two-char operator is one
      // boundary; a lone `&` (background job separator) or `|` splits too,
      // so a second backgrounded/piped reveal is staged rather than
      // swallowed into the first segment.
      segments.push(current);
      current = "";
      i += command[i + 1] === ch ? 2 : 1;
      continue;
    }
    if (ch === ";" || ch === "\n") {
      segments.push(current);
      current = "";
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  segments.push(current);
  return segments;
}

/**
 * Extract credential refs from a shell command that may contain one or more
 * `credentials reveal` invocations (compound commands split on shell
 * separators). Returns an empty array for commands that never touch reveal —
 * the hot-path cost is one substring check.
 *
 * The parse is deliberately conservative: it recognizes the documented CLI
 * shapes (`--service X --field Y`, `--service=X`, quoted values, positional
 * UUID) and nothing else. An unparseable invocation yields no ref, which
 * downstream means no candidate and a plain (non-revealable) sentinel —
 * the safe direction.
 */
/**
 * Slice a segment at each `credentials reveal` occurrence: one slice per
 * invocation, running from the invocation to the start of the next.
 * Command substitution can nest several reveals in ONE segment —
 * `echo "$(… reveal --service a …)" "$(… reveal --service b …)"` — and
 * parsing only the segment's first flag pair would leave every later
 * identity unstaged even though the route proves each one, so their
 * opaque values could stream and persist raw.
 */
function revealInvocationSlices(segment: string): string[] {
  const re = new RegExp(REVEAL_INVOCATION_RE, "g");
  const starts: number[] = [];
  for (let m = re.exec(segment); m !== null; m = re.exec(segment)) {
    starts.push(m.index);
  }
  return starts.map((start, i) => segment.slice(start, starts[i + 1]));
}

export function collectRevealRefsFromCommand(
  command: string,
): RevealCandidateRef[] {
  if (!command.includes("reveal")) {
    return [];
  }
  const refs: RevealCandidateRef[] = [];
  // Split compound commands so flags from one invocation can't bleed into
  // another (`reveal --service a --field b && reveal --service c --field d`),
  // honoring quotes so a separator inside a flag value can't cut the
  // invocation apart (see `splitShellSegments`). Within a segment, each
  // reveal invocation is parsed from its own slice (see
  // `revealInvocationSlices`).
  const segments = splitShellSegments(command);
  for (const segment of segments) {
    if (!REVEAL_INVOCATION_RE.test(segment)) {
      continue;
    }
    for (const invocation of revealInvocationSlices(segment)) {
      const service = flagValue(invocation, SERVICE_FLAG_RE);
      const field = flagValue(invocation, FIELD_FLAG_RE);
      if (service !== undefined && field !== undefined) {
        refs.push({ service, field });
        continue;
      }
      const id = UUID_RE.exec(invocation)?.[0];
      if (id) {
        refs.push({ id });
        continue;
      }
      const positional = POSITIONAL_RE.exec(invocation)?.[1];
      const pathRef =
        positional === undefined ? undefined : parseServiceFieldRef(positional);
      if (pathRef) {
        refs.push(pathRef);
      }
      // No parseable identity → no ref. The span still gets redacted at
      // persist; it just won't be revealable.
    }
  }
  return refs;
}

/**
 * Resolve id-form refs to service/field EAGERLY, at staging time — a
 * metadata-only lookup, no secret access. Proof runs when the tool result
 * arrives, which can be well after the reveal executed, and a `credentials
 * remove` in between (even in the same compound command) makes the id
 * unresolvable then — dropping the ref although the route recorded the
 * success, so the printed value would persist raw. The id stays on the ref
 * so proof time can still fall back to a lookup for a ref whose metadata
 * only appears later.
 */
export function resolveRefIdentities(
  refs: readonly RevealCandidateRef[],
): RevealCandidateRef[] {
  return refs.map((ref) => {
    if (
      ref.id === undefined ||
      (ref.service !== undefined && ref.field !== undefined)
    ) {
      return ref;
    }
    try {
      const meta = getCredentialMetadataById(ref.id);
      if (!meta) {
        return ref;
      }
      return { ...ref, service: meta.service, field: meta.field };
    } catch (err) {
      log.debug(
        { err },
        "eager reveal ref id lookup failed; deferring to proof time",
      );
      return ref;
    }
  });
}

/**
 * Keep only refs whose identity the reveal route ACTUALLY served after
 * `watermark` was captured (see `reveal-success-registry`). A shell tool's
 * overall success is not proof the nested reveal ran — `reveal … || true`
 * succeeds when the route failed, and an `echo` containing the command
 * text never calls the route — so candidate resolution (which reads
 * plaintext from the store) must be gated on the route's own record.
 * Identity for id-form refs is normally captured at staging (see
 * `resolveRefIdentities`); the metadata lookup here is only a fallback —
 * metadata-only, no secret access. Unresolvable refs are dropped — the
 * safe direction.
 */
export function filterRefsByRevealProof(
  refs: readonly RevealCandidateRef[],
  watermark: number,
  nonce: string,
): RevealCandidateRef[] {
  const proven: RevealCandidateRef[] = [];
  const seenValues = new Set<string>();
  for (const ref of refs) {
    let service = ref.service;
    let field = ref.field;
    if (
      ref.id !== undefined &&
      (service === undefined || field === undefined)
    ) {
      try {
        const meta = getCredentialMetadataById(ref.id);
        if (!meta) {
          continue;
        }
        service = meta.service;
        field = meta.field;
      } catch (err) {
        log.debug({ err }, "reveal proof id lookup failed; dropping ref");
        continue;
      }
    }
    if (service === undefined || field === undefined) {
      continue;
    }
    // Capture the plaintexts the route served alongside the proof, in the
    // same lookup. Resolving service/field here too means each returned ref
    // is fully self-describing, so candidate resolution needs neither the
    // metadata lookup nor the vault read again. One ref PER DISTINCT VALUE:
    // a rotate-and-re-reveal inside the window (reveal v1 → `credentials
    // set` → reveal v2) prints two different plaintexts to stdout, and
    // keeping only one would let the other persist raw whenever the scanner
    // cannot classify it.
    for (const provenValue of revealedValuesSince(
      watermark,
      service,
      field,
      nonce,
    )) {
      const dedupeKey = JSON.stringify([service, field, provenValue]);
      if (seenValues.has(dedupeKey)) {
        continue;
      }
      seenValues.add(dedupeKey);
      proven.push({ service, field, provenValue });
    }
  }
  return proven;
}

// ---------------------------------------------------------------------------
// Candidate resolution (scoped store read)
// ---------------------------------------------------------------------------

/**
 * Minimum plaintext length for the exact-match candidate fallback. The
 * fallback replaces EVERY occurrence of a candidate's bytes across the
 * rest of the turn — assistant text, tool output, persisted rows — and
 * the set route validates values only as non-empty, so a credential whose
 * plaintext is `1` or `ok` would turn every unrelated occurrence of that
 * token into a marker/chip. Below this floor the value carries too little
 * entropy for redaction to protect anything, while the false-positive
 * damage is guaranteed; at or above it, collisions with incidental text
 * are rare. Scanner-recognized secrets are unaffected — every scanner
 * pattern requires far longer tokens than this.
 */
const MIN_CANDIDATE_VALUE_LENGTH = 6;

/**
 * Every textual encoding of a credential plaintext that can appear on a
 * transcript surface: the raw value plus its JSON-escaped form
 * (`JSON.stringify` minus the outer quotes). They differ when the value
 * contains quotes, backslashes, or control characters — a PEM key's
 * newlines — because tool stdout (`credentials reveal --json` writes
 * through `JSON.stringify`) and persisted tool_use inputs carry the
 * ESCAPED bytes, which a raw exact-match list can never find.
 * `JSON.stringify` is injective on the value, so an escaped-form match
 * proves the same identity the raw form does. Deduped: a value needing no
 * escaping yields a single entry.
 */
export function credentialValueEncodings(value: string): string[] {
  const encodings = [value];
  const escaped = JSON.stringify(value).slice(1, -1);
  if (escaped !== value) {
    encodings.push(escaped);
  }
  return encodings;
}

/**
 * Append a candidate in EVERY stdout encoding of its plaintext
 * ({@link credentialValueEncodings}), deduped on identity+value.
 * Registering the escaped encoding as its own candidate covers that
 * representation on every surface (persist byte-compare, live guard,
 * tool_result fallback, output chunks).
 */
function appendCandidateEncodings(
  candidates: ResolvedRevealCandidate[],
  seen: Set<string>,
  service: string,
  field: string,
  value: string,
): void {
  for (const encoded of credentialValueEncodings(value)) {
    if (encoded.length < MIN_CANDIDATE_VALUE_LENGTH) {
      continue;
    }
    const dedupeKey = JSON.stringify([service, field, encoded]);
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    candidates.push({ service, field, value: encoded });
  }
}

/**
 * Sync twin of {@link resolveRevealCandidates} for refs that already carry
 * a proven value (the shape `filterRefsByRevealProof` returns) — used on
 * the live tool-output path, whose handler must stay synchronous and may
 * not touch the vault. Refs without a proven value are skipped, never
 * vault-resolved.
 */
export function resolveProvenRevealCandidates(
  refs: readonly RevealCandidateRef[],
): ResolvedRevealCandidate[] {
  const seen = new Set<string>();
  const candidates: ResolvedRevealCandidate[] = [];
  for (const ref of refs) {
    if (ref.service === undefined || ref.field === undefined) {
      continue;
    }
    if (ref.provenValue === undefined || ref.provenValue.length === 0) {
      continue;
    }
    appendCandidateEncodings(
      candidates,
      seen,
      ref.service,
      ref.field,
      ref.provenValue,
    );
  }
  return candidates;
}

/**
 * Resolve parsed refs to `{service, field, value}` candidates via scoped
 * credential-store reads — one `getSecureKeyAsync` per distinct ref, only
 * for credentials a reveal command in this turn already named. Refs that
 * fail to resolve (unknown id, missing secret, store unreachable) are
 * dropped; the corresponding spans persist as plain sentinels.
 */
export async function resolveRevealCandidates(
  refs: readonly RevealCandidateRef[],
): Promise<ResolvedRevealCandidate[]> {
  // Candidates dedupe on identity AND value, not identity alone: the same
  // credential legitimately yields two candidates when it was rotated and
  // re-revealed within one turn — both plaintexts hit a tool's stdout, so
  // both must stay redactable. Vault reads still dedupe per identity (one
  // scoped read per credential, and the vault only has the current value).
  const seenCandidates = new Set<string>();
  const vaultReadKeys = new Set<string>();
  const candidates: ResolvedRevealCandidate[] = [];
  const pushCandidate = (service: string, field: string, value: string) =>
    appendCandidateEncodings(candidates, seenCandidates, service, field, value);
  for (const ref of refs) {
    let service = ref.service;
    let field = ref.field;
    if (
      ref.id !== undefined &&
      (service === undefined || field === undefined)
    ) {
      try {
        const meta = getCredentialMetadataById(ref.id);
        if (!meta) {
          continue;
        }
        service = meta.service;
        field = meta.field;
      } catch (err) {
        log.debug({ err }, "reveal candidate id lookup failed; skipping");
        continue;
      }
    }
    if (service === undefined || field === undefined) {
      continue;
    }
    // Prefer the plaintext the reveal route actually served (captured at proof
    // time). Re-reading the vault here would return a rotated or deleted
    // value, so the guard/fallback could miss the exact bytes the tool
    // printed. Only fall back to a store read when a ref carries no proven
    // value — which today means it was constructed outside the proof path.
    if (ref.provenValue !== undefined && ref.provenValue.length > 0) {
      pushCandidate(service, field, ref.provenValue);
      continue;
    }
    const key = credentialKey(service, field);
    if (vaultReadKeys.has(key)) {
      continue;
    }
    vaultReadKeys.add(key);
    try {
      const value = await getSecureKeyAsync(key);
      if (value != null && value.length > 0) {
        pushCandidate(service, field, value);
      }
    } catch (err) {
      // Store unreachable → no candidate → plain sentinel. Never block or
      // fail the persist over enrichment.
      log.debug(
        { err, service, field },
        "reveal candidate fetch failed; span will persist as plain sentinel",
      );
    }
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// Sentinel trigger + legacy marker
// ---------------------------------------------------------------------------

const SENTINEL_TRIGGER = `${REDACTED_SENTINEL_OPEN}${REDACTED_SENTINEL_TAG}:`;

const FALLBACK_SENTINEL_TYPE = "Credential";

/**
 * The generic legacy redaction marker for a credential value — byte-identical
 * everywhere a credential span is replaced without a proven identity
 * (persist-time fallback protection, the retroactive transcript scrub), so
 * downstream scanners and renderers treat every redacted span the same way.
 */
export const LEGACY_CREDENTIAL_REDACTION_MARKER = `<redacted type="${FALLBACK_SENTINEL_TYPE}" />`;

/**
 * Length of the prefix of `buffer` that is stable under the trigger's
 * neutralization: a COMPLETE trigger in the consumed region commits (it
 * neutralizes to the same bytes no matter what arrives next); a trailing
 * PROPER PREFIX of the trigger must be held back — a future chunk could
 * complete it into a trigger, and emitting it raw would let a split
 * forgery survive.
 */
function stableEmitLen(buffer: string, targets: readonly string[]): number {
  const target = targets[0]!;
  const maxLen = Math.min(target.length - 1, buffer.length);
  for (let len = maxLen; len > 0; len--) {
    if (buffer.endsWith(target.slice(0, len))) {
      return buffer.length - len;
    }
  }
  return buffer.length;
}

/**
 * Streaming redaction guard for live `assistant_text_delta` emission
 * (mirrors `drainDirectiveDisplayBuffer`'s hold-back pattern). Two jobs:
 *
 * 1. **Forgery neutralization** — genuine sentinels are created by the
 *    daemon, so a sentinel-shaped string the model streams neutralizes
 *    unless a re-mint authority for its identity exists this turn
 *    (`--for-chat` mints and proven reveal candidates — see
 *    `guardForChatSentinels`), in which case it is restored to the
 *    daemon's canonical mint.
 * 2. **Live reveal swap** — a complete occurrence of a reveal candidate's
 *    plaintext is replaced with its enriched sentinel (`entries`), so the
 *    secret never flashes in the live stream: the client renders the chip
 *    immediately and the persisted row (which redacts the same bytes at
 *    persist time) matches what was streamed.
 *
 * A trailing PARTIAL trigger or candidate-value prefix (split across
 * streaming chunks) is held back in `bufferedRemainder` so the next chunk
 * decides whether it completes; when that partial prefix could outrank a
 * completed occurrence it starts inside, the whole occurrence is held with
 * it (see `stableEmitLen`), so the remainder is bounded by roughly twice
 * the longest target. Callers must re-prepend the remainder to
 * the next chunk and, at end-of-message, flush it through
 * `neutralizeAndSwapLiveRevealValues` — nothing can complete a partial
 * prefix after the message ends.
 *
 * `consumedRaw` is the untransformed input the emit covers. Callers that
 * mirror streamed text for partial persistence must mirror `consumedRaw`,
 * not `emitText`: persist-time redaction re-derives the sentinel from the
 * raw bytes, whereas a mirrored already-swapped sentinel would be
 * indistinguishable from a forgery and get neutralized.
 */
/**
 * Upper bound on how much tail the guard will hold back waiting for an
 * in-flight daemon-minted sentinel to close. A genuine sentinel is far
 * shorter (type + encoded service/field); a trigger that runs this long
 * without closing is forged garbage and is released (neutralized) rather
 * than buffered forever.
 */
export function drainSentinelGuardedText(buffer: string): {
  emitText: string;
  consumedRaw: string;
  bufferedRemainder: string;
} {
  // The trigger is the only hold target: a complete live sentinel is forged
  // by definition (genuine sentinels are created at persist time), and a
  // trailing partial must not survive a chunk boundary where neutralization
  // could miss it.
  const emitLen = stableEmitLen(buffer, [SENTINEL_TRIGGER]);
  const consumedRaw = buffer.slice(0, emitLen);
  return {
    emitText: neutralizeRedactedSentinels(consumedRaw),
    consumedRaw,
    bufferedRemainder: buffer.slice(emitLen),
  };
}

/**
 * Streaming redaction guard for live `tool_output_chunk` emission — the
 * tool-output twin of {@link drainSentinelGuardedText}. A foreground
 * reveal's stdout streams to the client WHILE the tool runs, before the
 * tool_result seam redacts the final content, so each chunk must be
 * redacted on the way out or the plaintext shows in the tool drawer until
 * the redacted result replaces it. Complete occurrences of candidate
 * values become the legacy marker (this surface renders no chips, and the
 * final tool_result row uses the same treatment, so live and persisted
 * bytes agree); a trailing partial occurrence is held back in
 * `bufferedRemainder` for the tool's next chunk. The tool_result seam
 * DISCARDS whatever remains: a held partial is raw credential prefix
 * bytes that complete-value redaction cannot mask, and the redacted final
 * result supersedes the streamed view immediately.
 */
export function drainCandidateGuardedChunk(
  buffer: string,
  candidates: readonly ResolvedRevealCandidate[],
): { emitText: string; bufferedRemainder: string } {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const candidate of candidates) {
    if (candidate.value.length === 0 || seen.has(candidate.value)) {
      continue;
    }
    seen.add(candidate.value);
    values.push(candidate.value);
  }
  values.sort((a, b) => b.length - a.length);
  const emitLen = stableEmitLen(buffer, values);
  return {
    emitText: redactCandidateValuesLegacy(buffer.slice(0, emitLen), candidates),
    bufferedRemainder: buffer.slice(emitLen),
  };
}

// ---------------------------------------------------------------------------
// Sentinel redaction
// ---------------------------------------------------------------------------

interface RawSpan {
  start: number;
  end: number;
  /** Index into the caller's target list — lower = higher priority. */
  priority: number;
}

/**
 * Resolve the non-overlapping occurrence spans of `targets` in `text`:
 * targets in priority order (list index — callers sort longest-first so a
 * value that is a substring of another cannot pre-empt the larger match),
 * each target's occurrences greedy left-to-right, skipping any occurrence
 * that overlaps a higher-priority span. This is the single definition of
 * the transforms' occurrence semantics: every swap in this module rebuilds
 * its output from these spans, and the streaming stability analysis
 * (`stableEmitLen`) resolves through the same function, so the two can
 * never drift.
 *
 * `skipOccurrence` vetoes individual occurrences (the persist paths use it
 * to let a longer scanner match outrank a candidate substring inside it —
 * see `containedInLongerScannerMatch`); a vetoed occurrence is skipped
 * exactly like an overlap loss, and scanning continues from the next byte.
 */
function resolveRawSpans(
  text: string,
  targets: readonly string[],
  skipOccurrence?: (start: number, end: number) => boolean,
): RawSpan[] {
  const spans: RawSpan[] = [];
  targets.forEach((target, priority) => {
    if (target.length === 0) {
      return;
    }
    let scanFrom = 0;
    for (;;) {
      const idx = text.indexOf(target, scanFrom);
      if (idx === -1) {
        break;
      }
      const end = idx + target.length;
      // An occurrence overlapping a higher-priority span loses to it — the
      // higher-priority replacement consumes those bytes — but keep
      // scanning from the next byte for a later disjoint occurrence.
      if (
        spans.some((s) => idx < s.end && end > s.start) ||
        skipOccurrence?.(idx, end) === true
      ) {
        scanFrom = idx + 1;
        continue;
      }
      spans.push({ start: idx, end, priority });
      scanFrom = end;
    }
  });
  return spans;
}

/**
 * Replace each resolved raw span with its target's replacement, rebuilding
 * the string in ONE pass over the original text. A sequential
 * split/join-per-target pass would re-scan earlier replacements — and a
 * replacement sentinel is not inert text: it embeds type/service/field
 * segments, so a candidate whose plaintext happens to equal another's
 * service name (e.g. `openai`) would match inside the just-emitted
 * sentinel and corrupt it into nested, unrenderable markers. Resolving all
 * spans against the raw text first makes replacements structurally
 * invisible to later targets.
 *
 * `transformGap` is applied to the text BETWEEN spans (and to the whole
 * text when nothing matches). Callers use it for forgery neutralization:
 * it must run over raw bytes the spans do not claim, and never over the
 * spans themselves — a candidate value may itself contain the sentinel
 * trigger, and mutating it before the exact-match resolution would break
 * the strongest guarantee this module makes.
 */
function replaceRawSpans(
  text: string,
  targets: readonly string[],
  replacementFor: (priority: number) => string,
  transformGap: (segment: string) => string = (segment) => segment,
  skipOccurrence?: (start: number, end: number) => boolean,
): string {
  const spans = resolveRawSpans(text, targets, skipOccurrence);
  if (spans.length === 0) {
    return transformGap(text);
  }
  spans.sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  for (const span of spans) {
    out +=
      transformGap(text.slice(cursor, span.start)) +
      replacementFor(span.priority);
    cursor = span.end;
  }
  return out + transformGap(text.slice(cursor));
}

/**
 * Occurrence veto that lets a LONGER scanner match outrank a candidate
 * substring inside it. A proven value can be a strict substring of a
 * DIFFERENT scanner-detectable secret — revealing a manual value `sk-pro`
 * must not carve the prefix out of a full `sk-proj-…` key in the same
 * text and leave the key's suffix raw. Vetoing the occurrence keeps the
 * enclosing secret contiguous in a gap, where the scanner pass redacts it
 * whole. The reverse containment keeps the candidate: a scanner match
 * INSIDE a candidate value (a PEM key, where only the header is
 * recognized) must not break whole-value protection, and an equal-length
 * match is the candidate itself — the enriched sentinel wins.
 */
function containedInLongerScannerMatch(
  text: string,
): (start: number, end: number) => boolean {
  const matches = scanText(text);
  if (matches.length === 0) {
    return () => false;
  }
  return (start, end) =>
    matches.some(
      (m) =>
        m.startIndex <= start &&
        end <= m.endIndex &&
        m.endIndex - m.startIndex > end - start,
    );
}

/**
 * Legacy-marker twin of the persist fallback, for surfaces that keep the
 * `<redacted type/>` marker instead of sentinels (persisted tool_result
 * blocks — see `buildToolResultBlocks`). A `credentials reveal` whose
 * stdout is an opaque/manual value with no scanner-recognizable shape
 * would otherwise persist raw in the tool-result row and surface in the
 * tool detail panel and history, even though every other surface redacts
 * it. Exact occurrences of proven candidate plaintexts (deduped, longest
 * value first) become the generic legacy marker; no identity is carried —
 * these surfaces render no chips.
 */
export function redactCandidateValuesLegacy(
  text: string,
  candidates: readonly ResolvedRevealCandidate[],
): string {
  // Protect every proven candidate value as an atomic legacy marker
  // (neutralizing forged sentinels in the text between the spans), THEN run
  // the scanner over what remains. Candidate spans resolve on the RAW
  // bytes: a manual value may itself contain the sentinel trigger, and
  // neutralizing the whole text first would mutate the occurrence and
  // break the exact match. Candidate protection must precede the scanner:
  // a value the scanner only partially recognizes (a PEM key, where the
  // `Private Key` pattern consumes just the header) would otherwise have
  // its recognized substring replaced first, destroying the full-value
  // match so the key body persists raw. The inserted `<redacted … />`
  // markers contain no secret-shaped bytes, so the scanner pass can
  // neither re-match nor corrupt them.
  const protectedText = protectCandidateValuesLegacy(text, candidates);
  return redactSecrets(protectedText);
}

/**
 * Replace every occurrence of a proven candidate plaintext with the generic
 * legacy marker BEFORE the scanner runs (longest value first, mirroring
 * `swapLiveRevealValues`). Twin of {@link protectCandidateSpans} for surfaces
 * that keep the `<redacted type="…" />` marker instead of sentinels; no
 * identity is carried — these surfaces render no chips, so the generic type
 * is always used.
 */
function protectCandidateValuesLegacy(
  text: string,
  candidates: readonly ResolvedRevealCandidate[],
): string {
  if (candidates.length === 0) {
    return neutralizeRedactedSentinels(text);
  }
  const seen = new Set<string>();
  const values: string[] = [];
  for (const candidate of candidates) {
    if (candidate.value.length === 0 || seen.has(candidate.value)) {
      continue;
    }
    seen.add(candidate.value);
    values.push(candidate.value);
  }
  values.sort((a, b) => b.length - a.length);
  return replaceRawSpans(
    text,
    values,
    () => LEGACY_CREDENTIAL_REDACTION_MARKER,
    neutralizeRedactedSentinels,
    containedInLongerScannerMatch(text),
  );
}
