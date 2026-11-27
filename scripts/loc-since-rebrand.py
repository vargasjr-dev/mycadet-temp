#!/usr/bin/env python3
"""Track the monorepo's net LoC since the vellum→cadet rebrand.

Vargas's metric (2026-10-31): how far the rebrand-era deletion campaign has
taken us — the goal is −1M LoC from the rebrand point (f32894e7e4, 2026-10-06,
"@vellumai" → "@mycadet") to HEAD.

Counts SOURCE lines only: .ts .tsx .js .jsx .mjs .cjs .css .scss .html .sh
.sql .py .swift .kt, excluding node_modules, dist/, build/, .next/, vendor/,
*.snap, lockfiles. Measures the TREE at each ref (not diff ins/del — the
formation-day commits vendored node_modules, which poisons shortstat).

Usage: python3 loc-since-rebrand.py [repo] [--out snapshot.json]
Writes the app's snapshot (--out, with history for trend) and appends a JSONL
measurement to loc-since-rebrand.log next to this script.
"""
import json, re, subprocess, sys, datetime, os

BASE_REF = "f32894e7e4"  # rebrand: flip npm scope from @vellumai to @mycadet (#12)
LOG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "loc-since-rebrand.log")

EXT = re.compile(r"\.(ts|tsx|js|jsx|mjs|cjs|css|scss|html|sh|sql|py|swift|kt)$")
BAD = re.compile(r"(node_modules/|/dist/|/build/|\.next/|vendor/|\.snap$|bun\.lock$|package-lock)")

args = [a for a in sys.argv[1:]]
repo = next((a for a in args if not a.startswith("--")), ".")
out_path = args[args.index("--out") + 1] if "--out" in args else None

def run_git(*cmd):
    return subprocess.run(["git", *cmd], capture_output=True, text=True, check=True, cwd=repo).stdout

def tree_loc(ref):
    paths = [p for p in run_git("ls-tree", "-r", "--name-only", ref).splitlines()
             if EXT.search(p) and not BAD.search(p)]
    proc = subprocess.Popen(["git", "cat-file", "--batch"], stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, cwd=repo)
    total = 0
    for p in paths:
        proc.stdin.write(f"{ref}:{p}\n".encode())
        proc.stdin.flush()
        header = proc.stdout.readline().decode()
        m = re.search(r"blob (\d+)", header)
        if not m:
            continue
        size = int(m.group(1))
        body = proc.stdout.read(size)
        proc.stdout.read(1)
        total += body.count(b"\n")
    proc.stdin.close()
    proc.wait()
    return total, len(paths)

def main():
    base_full = run_git("rev-parse", BASE_REF).strip()
    head_full = run_git("rev-parse", "HEAD").strip()
    head_short = head_full[:9]
    head_date = run_git("show", "-s", "--format=%ad", "--date=short", HEAD := "HEAD").strip()

    base_loc, _ = tree_loc(base_full)
    head_loc, head_files = tree_loc(head_full)
    net = head_loc - base_loc
    sign = "+" if net >= 0 else ""
    print(f"HEAD {head_short} ({head_date}): {head_loc:,} LoC across {head_files:,} source files")
    print(f"vs rebrand {BASE_REF}: {sign}{net:,} LoC   (rebrand-point tree: {base_loc:,})")

    snapshot = None
    if out_path and os.path.exists(out_path):
        try:
            snapshot = json.loads(open(out_path).read())
        except (ValueError, OSError):
            snapshot = None
    history = (snapshot or {}).get("history", []) if snapshot else []
    history = [h for h in history if h.get("head") != head_full][-39:]
    history.append({"date": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
                    "head": head_full, "net": net})
    if history[:-1]:
        print(f"trend: {net - history[-2]['net']:+,} vs measurement on {history[-2]['date']} (was {history[-2]['net']:+,})")

    now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    with open(LOG, "a") as f:
        f.write(json.dumps({
            "date": now, "head": head_full, "head_date": head_date,
            "loc": head_loc, "base_loc": base_loc, "net": net, "files": head_files,
        }) + "\n")

    if out_path:
        with open(out_path, "w") as f:
            json.dump({
                "measuredAt": now, "head": head_short, "headDate": head_date,
                "loc": head_loc, "baseLoc": base_loc, "net": net, "files": head_files,
                "goal": -1_000_000, "history": history,
            }, f, indent=2)
            f.write("\n")
        print(f"snapshot: {out_path}")

main()
