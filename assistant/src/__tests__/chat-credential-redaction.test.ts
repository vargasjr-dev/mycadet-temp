/**
 * Tests for the chat-persist sentinel redaction path (LUM-2768).
 *
 * Covers the three stages independently: reveal-command parsing (pure
 * string work), candidate resolution (mocked credential store), and the
 * byte-match sentinel substitution. The failure-direction invariant is the
 * core assertion set: anything short of an exact plaintext match must
 * degrade to the plain (non-revealable) sentinel, never a mislabeled
 * enriched one.
 */
import { describe, expect, mock, test } from "bun:test";

import { useMemorySecureKeys } from "./helpers/secure-keys.js";

const SECRET_STORE = useMemorySecureKeys();

mock.module("../tools/credentials/metadata-store.js", () => ({
  getCredentialMetadataById: (id: string) =>
    id === "11111111-2222-4333-8444-555555555555"
      ? { service: "openai", field: "api_key" }
      : undefined,
}));

// ── Imports (after mocks) ────────────────────────────────────────────────
import { neutralizeRedactedSentinels } from "@mycadet/service-contracts/redacted-credential";

import {
  collectRevealRefsFromCommand,
  drainCandidateGuardedChunk,
  drainSentinelGuardedText,
  filterRefsByRevealProof,
  redactCandidateValuesLegacy,
  resolveProvenRevealCandidates,
  resolveRefIdentities,
  resolveRevealCandidates,
} from "../daemon/chat-credential-redaction.js";
import {
  _resetRevealSuccessRegistryForTest,
  openRevealProofWindow,
  recordRevealSuccess,
} from "../runtime/reveal-success-registry.js";
import { redactSecrets } from "../security/secret-scanner.js";
import {
  OPENAI_PROJECT_KEY_REDACTION_MARKER,
  SYNTHETIC_OPENAI_PROJECT_KEY,
} from "./secret-fixtures.js";

const UUID = "11111111-2222-4333-8444-555555555555";

describe("collectRevealRefsFromCommand", () => {
  test("parses --service/--field flags", () => {
    expect(
      collectRevealRefsFromCommand(
        "assistant credentials reveal --service openai --field api_key",
      ),
    ).toEqual([{ service: "openai", field: "api_key" }]);
  });

  test("parses = and quoted flag values", () => {
    expect(
      collectRevealRefsFromCommand(
        `assistant credentials reveal --service="github-app" --field 'pem'`,
      ),
    ).toEqual([{ service: "github-app", field: "pem" }]);
  });

  test("parses a positional UUID", () => {
    expect(
      collectRevealRefsFromCommand(`assistant credentials reveal ${UUID}`),
    ).toEqual([{ id: UUID }]);
  });

  test("splits compound commands so flags cannot bleed across invocations", () => {
    expect(
      collectRevealRefsFromCommand(
        "assistant credentials reveal --service a --field b && assistant credentials reveal --service c --field d",
      ),
    ).toEqual([
      { service: "a", field: "b" },
      { service: "c", field: "d" },
    ]);
  });

  test("splits on a single & background separator", () => {
    expect(
      collectRevealRefsFromCommand(
        "assistant credentials reveal --service a --field b & assistant credentials reveal --service c --field d",
      ),
    ).toEqual([
      { service: "a", field: "b" },
      { service: "c", field: "d" },
    ]);
  });

  test("does not treat && as two single-& separators", () => {
    // The two-char operator must win at its position; a spurious empty split
    // between the ampersands would drop the second invocation's flags.
    expect(
      collectRevealRefsFromCommand(
        "assistant credentials reveal --service a --field b&&assistant credentials reveal --service c --field d",
      ),
    ).toEqual([
      { service: "a", field: "b" },
      { service: "c", field: "d" },
    ]);
  });

  test("a quoted separator inside a flag value does not split the invocation", () => {
    // Service/field identifiers are arbitrary strings; a shell separator
    // inside quotes is part of the value. Cutting there would orphan the
    // flags across two broken segments and stage nothing — and an
    // unstageable reveal's opaque output could stream or persist raw.
    expect(
      collectRevealRefsFromCommand(
        "assistant credentials reveal --service 'R&D' --field token",
      ),
    ).toEqual([{ service: "R&D", field: "token" }]);
  });

  test("quoted separators cannot swallow a following invocation", () => {
    expect(
      collectRevealRefsFromCommand(
        'assistant credentials reveal --service "a&&b;c" --field x && assistant credentials reveal --service d --field e',
      ),
    ).toEqual([
      { service: "a&&b;c", field: "x" },
      { service: "d", field: "e" },
    ]);
  });

  test("unescapes backslash-escaped characters in unquoted flag values", () => {
    // The shell strips escaping before the CLI sees argv, so the reveal
    // route records proof under the UNESCAPED identity — the parse must
    // agree or the staged ref can never match its proof.
    expect(
      collectRevealRefsFromCommand(
        "assistant credentials reveal --service foo\\ bar --field token",
      ),
    ).toEqual([{ service: "foo bar", field: "token" }]);
    expect(
      collectRevealRefsFromCommand(
        "assistant credentials reveal --service a\\&b --field x",
      ),
    ).toEqual([{ service: "a&b", field: "x" }]);
  });

  test("unescapes POSIX-escapable characters inside double-quoted values", () => {
    expect(
      collectRevealRefsFromCommand(
        'assistant credentials reveal --service "a\\"b" --field x',
      ),
    ).toEqual([{ service: 'a"b', field: "x" }]);
  });

  test("stages every reveal invocation within one segment", () => {
    // Command substitution nests several reveals in ONE segment; each must
    // stage its own ref — parsing only the first flag pair would leave the
    // later identities unstaged even though the route proves them.
    expect(
      collectRevealRefsFromCommand(
        'echo "$(assistant credentials reveal --service a --field token)" "$(assistant credentials reveal --service b --field token)"',
      ),
    ).toEqual([
      { service: "a", field: "token" },
      { service: "b", field: "token" },
    ]);
  });

  test("a substitution's closing paren does not glue onto the parsed value", () => {
    expect(
      collectRevealRefsFromCommand(
        'KEY="$(assistant credentials reveal --service openai --field api_key)"',
      ),
    ).toEqual([{ service: "openai", field: "api_key" }]);
  });

  test("stages two UUID reveals nested in one segment", () => {
    const other = "99999999-9999-4999-8999-999999999999";
    expect(
      collectRevealRefsFromCommand(
        `echo "$(assistant credentials reveal ${UUID})" "$(assistant credentials reveal ${other})"`,
      ),
    ).toEqual([{ id: UUID }, { id: other }]);
  });

  test("ignores commands without a reveal invocation", () => {
    expect(collectRevealRefsFromCommand("echo hello")).toEqual([]);
    expect(collectRevealRefsFromCommand("assistant credentials list")).toEqual(
      [],
    );
  });

  test("parses a legacy service/field path", () => {
    expect(
      collectRevealRefsFromCommand(
        "assistant credentials reveal resend/api_key",
      ),
    ).toEqual([{ service: "resend", field: "api_key" }]);
  });

  test("legacy path survives malformed extra arguments", () => {
    expect(
      collectRevealRefsFromCommand(
        "assistant credentials reveal resend/api_key --json extra",
      ),
    ).toEqual([{ service: "resend", field: "api_key" }]);
  });

  test("unparseable invocation yields no ref (fails safe)", () => {
    expect(
      collectRevealRefsFromCommand("assistant credentials reveal --service x"),
    ).toEqual([]);
  });
});

describe("resolveRevealCandidates", () => {
  test("resolves service/field refs via the scoped store read", async () => {
    SECRET_STORE["credential/openai/api_key"] = SYNTHETIC_OPENAI_PROJECT_KEY;
    const out = await resolveRevealCandidates([
      { service: "openai", field: "api_key" },
    ]);
    expect(out).toEqual([
      {
        service: "openai",
        field: "api_key",
        value: SYNTHETIC_OPENAI_PROJECT_KEY,
      },
    ]);
  });

  test("resolves a UUID ref through metadata and dedupes with the flag ref", async () => {
    SECRET_STORE["credential/openai/api_key"] = SYNTHETIC_OPENAI_PROJECT_KEY;
    const out = await resolveRevealCandidates([
      { id: UUID },
      { service: "openai", field: "api_key" },
    ]);
    expect(out).toHaveLength(1);
  });

  test("drops unknown ids and missing secrets", async () => {
    delete SECRET_STORE["credential/gone/api_key"];
    const out = await resolveRevealCandidates([
      { id: "99999999-9999-4999-8999-999999999999" },
      { service: "gone", field: "api_key" },
    ]);
    expect(out).toEqual([]);
  });

  test("keeps both values when the same credential was rotated and re-revealed", async () => {
    // reveal v1 → `credentials set` → reveal v2 inside one turn: the route
    // served BOTH plaintexts to the tool's stdout, so both must survive as
    // candidates. Deduping on identity alone would drop one and let it
    // stream/persist raw whenever the scanner cannot classify it.
    const out = await resolveRevealCandidates([
      {
        service: "openai",
        field: "api_key",
        provenValue: "hunter2-rotated-alpha",
      },
      {
        service: "openai",
        field: "api_key",
        provenValue: "hunter2-rotated-beta",
      },
    ]);
    expect(out).toEqual([
      { service: "openai", field: "api_key", value: "hunter2-rotated-alpha" },
      { service: "openai", field: "api_key", value: "hunter2-rotated-beta" },
    ]);
  });

  test("still dedupes proven refs that agree on identity AND value", async () => {
    const out = await resolveRevealCandidates([
      { service: "openai", field: "api_key", provenValue: "hunter2-same" },
      { service: "openai", field: "api_key", provenValue: "hunter2-same" },
    ]);
    expect(out).toHaveLength(1);
  });

  test("a value with JSON-escapable bytes also yields its escaped encoding", async () => {
    // `credentials reveal --json` prints the value through JSON.stringify,
    // so newlines/quotes/backslashes reach stdout ESCAPED — a representation
    // the raw exact-match list can never find. Both encodings must be
    // candidates.
    const out = await resolveRevealCandidates([
      { service: "github-app", field: "pem", provenValue: "line1\nline2" },
    ]);
    expect(out).toEqual([
      { service: "github-app", field: "pem", value: "line1\nline2" },
      { service: "github-app", field: "pem", value: "line1\\nline2" },
    ]);
  });

  test("drops values below the exact-match length floor", async () => {
    // The fallback global-replaces every occurrence of a candidate's bytes
    // for the rest of the turn; a trivial value like `ok` would shred
    // unrelated text into markers, and below the floor the value carries
    // no meaningful entropy to protect anyway.
    const out = await resolveRevealCandidates([
      { service: "svc", field: "f", provenValue: "ok" },
      { service: "svc", field: "g", provenValue: "12345" },
      { service: "svc", field: "h", provenValue: "123456" },
    ]);
    expect(out).toEqual([{ service: "svc", field: "h", value: "123456" }]);
  });

  test("a value with no escapable bytes yields a single candidate", async () => {
    const out = await resolveRevealCandidates([
      { service: "svc", field: "f", provenValue: "hunter2-plain" },
    ]);
    expect(out).toHaveLength(1);
  });
});

describe("resolveRefIdentities (eager staging lookup)", () => {
  test("resolves a UUID ref to service/field and keeps the id", () => {
    expect(resolveRefIdentities([{ id: UUID }])).toEqual([
      { id: UUID, service: "openai", field: "api_key" },
    ]);
  });

  test("passes an unknown id through for the proof-time fallback", () => {
    const ref = { id: "99999999-9999-4999-8999-999999999999" };
    expect(resolveRefIdentities([ref])).toEqual([ref]);
  });
});

describe("filterRefsByRevealProof identity handling", () => {
  test("a pre-resolved id ref stays proven after its metadata disappears", () => {
    // Staging resolved the id to service/field while the metadata still
    // existed; the credential was then removed before the tool result. The
    // carried identity must satisfy the proof — a metadata re-lookup would
    // fail and silently drop the ref for a value the tool already printed.
    _resetRevealSuccessRegistryForTest();
    openRevealProofWindow();
    recordRevealSuccess(
      "gone-service",
      "api_key",
      "hunter2-removed",
      "nonce-test",
    );
    const proven = filterRefsByRevealProof(
      [
        {
          id: "99999999-9999-4999-8999-999999999999",
          service: "gone-service",
          field: "api_key",
        },
      ],
      0,
      "nonce-test",
    );
    expect(proven).toEqual([
      {
        service: "gone-service",
        field: "api_key",
        provenValue: "hunter2-removed",
      },
    ]);
    _resetRevealSuccessRegistryForTest();
  });
});

describe("drainCandidateGuardedChunk (live tool output guard)", () => {
  const candidates = [{ service: "svc", field: "f", value: "hunter2-opaque" }];

  test("redacts a complete occurrence within one chunk", () => {
    const out = drainCandidateGuardedChunk(
      "value: hunter2-opaque\n",
      candidates,
    );
    expect(out.emitText).toBe('value: <redacted type="Credential" />\n');
    expect(out.bufferedRemainder).toBe("");
  });

  test("holds a trailing partial occurrence, then redacts on completion", () => {
    const first = drainCandidateGuardedChunk("out: hunter2-op", candidates);
    expect(first.emitText).toBe("out: ");
    expect(first.bufferedRemainder).toBe("hunter2-op");
    const second = drainCandidateGuardedChunk(
      first.bufferedRemainder + "aque done",
      candidates,
    );
    expect(second.emitText).toBe('<redacted type="Credential" /> done');
    expect(second.bufferedRemainder).toBe("");
  });

  test("passes clean chunks through whole", () => {
    const out = drainCandidateGuardedChunk("plain output\n", candidates);
    expect(out.emitText).toBe("plain output\n");
    expect(out.bufferedRemainder).toBe("");
  });

  test("resolveProvenRevealCandidates skips refs without a proven value", () => {
    expect(
      resolveProvenRevealCandidates([
        { service: "svc", field: "f" },
        { service: "svc", field: "f", provenValue: "hunter2-opaque" },
      ]),
    ).toEqual(candidates);
  });
});

describe("persisted text rider", () => {
  test("buildPersistedAssistantContent stamps _redactionVersion on text blocks", async () => {
    const { buildPersistedAssistantContent } =
      await import("../daemon/conversation-agent-loop-handlers.js");
    const [block] = buildPersistedAssistantContent(
      [{ type: "text", text: "hello" }],
      [],
    );
    expect((block as { _redactionVersion?: number })._redactionVersion).toBe(2);
  });
});

describe("legacy marker invariant", () => {
  test("redactSecrets output is byte-unchanged by this feature", () => {
    expect(redactSecrets(`key: ${SYNTHETIC_OPENAI_PROJECT_KEY}`)).toBe(
      `key: ${OPENAI_PROJECT_KEY_REDACTION_MARKER}`,
    );
  });
});
