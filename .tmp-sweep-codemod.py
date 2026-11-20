#!/usr/bin/env python3
"""Deep-entry -> root import sweep for the desktop clients (v4).

Parses the leading import section into statements (brace, side-effect,
default, comment, and whitespace-gap items), rewrites removed deep
specifiers to the root, reshapes default `log` imports to the root's named
export, and merges only statements that are both adjacent (nothing but
whitespace between) and same-target. Comments and blank lines are copied
through verbatim; nothing is reordered; nothing is dropped.
"""

import re
import subprocess

PKG = "@mycadet/electron-desktop"

KEEPS = {
    "about","app-logger","app-origin","auto-update","avatar","avatar-image",
    "bundle-flow","bundle-platform","command-palette-window","commands","devtools",
    "file-open","floating-window","notification-avatar-file","notification-avatar-path",
    "notifications","session-token-store","settings","status","status-icon","tray-model",
    "window-attention","window-state","capability-registry","file-open-preload","preload",
}

BRACE_RE = re.compile(r'import\s+(type\s+)?\{([^}]*)\}\s+from\s+"([^"]+)";', re.S)
SIDE_EFFECT_RE = re.compile(r'import\s+"([^"]+)";')
DEFAULT_RE = re.compile(r'import\s+(\w+)(\s*,\s*\{([^}]*)\})?\s+from\s+"([^"]+)";', re.S)
GAP_RE = re.compile(r'\s+')
COMMENT_RE = re.compile(r'//[^\n]*\n|/\*.*?\*/', re.S)
DYNAMIC_RE = re.compile(r'import\("' + re.escape(PKG) + r'/([a-z0-9/.\-]+)"\)')

files = subprocess.run(
    ["git", "ls-files", "clients"], capture_output=True, text=True
).stdout.split()

changed = 0
for f in files:
    if not f.endswith((".ts", ".tsx")):
        continue
    src = open(f).read()
    if PKG not in src and "./logger" not in src and "../logger" not in src:
        continue

    # Parse the leading import section.
    items = []
    pos = 0
    while pos < len(src):
        m = BRACE_RE.match(src, pos)
        if m:
            items.append({"s": m.start(), "e": m.end(), "kind": "brace",
                          "type_kw": m.group(1) or "", "names": m.group(2), "spec": m.group(3)})
            pos = m.end()
            continue
        m = SIDE_EFFECT_RE.match(src, pos)
        if m:
            items.append({"s": m.start(), "e": m.end(), "kind": "side", "spec": m.group(1)})
            pos = m.end()
            continue
        m = DEFAULT_RE.match(src, pos)
        if m:
            items.append({"s": m.start(), "e": m.end(), "kind": "default",
                          "default": m.group(1), "names": m.group(3) or "", "spec": m.group(4)})
            pos = m.end()
            continue
        m = COMMENT_RE.match(src, pos)
        if m:
            items.append({"s": m.start(), "e": m.end(), "kind": "comment"})
            pos = m.end()
            continue
        m = GAP_RE.match(src, pos)
        if m:
            items.append({"s": m.start(), "e": m.end(), "kind": "gap"})
            pos = m.end()
            continue
        break  # first non-import token: section over

    if not any(it["kind"] in ("brace", "default") for it in items):
        continue

    def target_for(spec: str) -> str:
        if spec.startswith(PKG + "/"):
            entry = spec[len(PKG) + 1:]
            return spec if entry in KEEPS else PKG
        if spec in ("./logger", "../logger"):
            return PKG
        return spec

    # Build pieces: one per item (gaps/comments copied verbatim). Absorbed
    # run members get "skip" so pieces stay aligned with items.
    pieces = []
    i = 0
    n = len(items)

    def gap_is_tight(idx: int) -> bool:
        return items[idx]["kind"] == "gap" and "\n\n" not in src[items[idx]["s"]:items[idx]["e"]]

    while i < n:
        it = items[i]
        if it["kind"] in ("gap", "comment", "side"):
            pieces.append(("raw", src[it["s"]:it["e"]]))
            i += 1
            continue
        if it["kind"] == "default":
            tgt = target_for(it["spec"])
            if tgt != PKG:
                pieces.append(("raw", src[it["s"]:it["e"]]))
                i += 1
                continue
            names = [x.strip() for x in it["names"].split(",") if x.strip()]
            names.append(it["default"])
            skips = 0
            j = i + 1
            while (
                j + 1 < n
                and gap_is_tight(j)
                and items[j + 1]["kind"] == "default"
                and target_for(items[j + 1]["spec"]) == PKG
            ):
                names.extend(x.strip() for x in items[j + 1]["names"].split(",") if x.strip())
                names.append(items[j + 1]["default"])
                skips += 1
                j += 2
            seen: dict[str, None] = {}
            for x in names:
                seen.setdefault(x, None)
            ordered = list(seen)
            pieces.append(("stmt", 'import { %s } from "%s";' % (", ".join(ordered), PKG)))
            for _ in range(skips * 2):
                pieces.append(("skip", None))
            i = j
            continue
        # brace
        type_kw = it["type_kw"]
        tgt = target_for(it["spec"])
        if tgt != PKG:
            pieces.append(("raw", src[it["s"]:it["e"]]))
            i += 1
            continue
        names = [x.strip() for x in it["names"].split(",") if x.strip()]
        skips = 0
        j = i + 1
        while (
            j + 1 < n
            and gap_is_tight(j)
            and items[j + 1]["kind"] == "brace"
            and items[j + 1]["type_kw"] == type_kw
            and target_for(items[j + 1]["spec"]) == PKG
        ):
            names.extend(x.strip() for x in items[j + 1]["names"].split(",") if x.strip())
            skips += 1
            j += 2
        seen = {}
        for x in names:
            seen.setdefault(x, None)
        ordered = list(seen)
        if len(ordered) > 2:
            pieces.append(("stmt", 'import %s{\n  %s,\n} from "%s";' % (type_kw, ",\n  ".join(ordered), PKG)))
        else:
            pieces.append(("stmt", 'import %s{ %s } from "%s";' % (type_kw, ", ".join(ordered), PKG)))
        for _ in range(skips * 2):
            pieces.append(("skip", None))
        i = j

    # Splice: walk items, copy inter-item source verbatim, emit pieces.
    out = []
    cursor = 0
    for it, (kind, piece) in zip(items, pieces):
        if kind == "skip":
            cursor = it["e"]
            continue
        out.append(src[cursor:it["s"]])
        out.append(piece)
        cursor = it["e"]
    out.append(src[cursor:])
    new_src = "".join(out)

    def dyn(m: re.Match) -> str:
        entry = m.group(1)
        return m.group(0) if entry in KEEPS else f'import("{PKG}")'

    new_src = DYNAMIC_RE.sub(dyn, new_src)

    if new_src != src:
        open(f, "w").write(new_src)
        changed += 1

print("changed files:", changed)
