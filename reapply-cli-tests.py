import re

def edit(p, pairs):
    s = open(p).read()
    for old, new, count in pairs:
        assert s.count(old) == count, (p, old[:70], s.count(old))
        s = s.replace(old, new)
    open(p, "w").write(s)
    print("ok", p)

# paired-lifecycle: keep the flag, cloud defaults local
edit("cli/src/__tests__/paired-lifecycle.test.ts", [(
"""    runtimeUrl: "http://10.0.0.9:7830",
    cloud: "paired",
    paired: true,""",
"""    runtimeUrl: "http://10.0.0.9:7830",
    paired: true,""", 1)])

# assistant-client-refresh: same shape
edit("cli/src/__tests__/assistant-client-refresh.test.ts", [(
"""    runtimeUrl: RUNTIME,
    cloud: "paired",
    paired: true,""",
"""    runtimeUrl: RUNTIME,
    paired: true,""", 1)])

# assistant-config: remote fixture keeps a non-local cloud
edit("cli/src/__tests__/assistant-config.test.ts", [('cloud: "gcp",', 'cloud: "custom",', 1)])

# backup: typed lookup mock needs cloud + flag
edit("cli/src/__tests__/backup.test.ts", [(
"""    assistantId: "test",
    cloud: "paired",
    runtimeUrl: "http://127.0.0.1:1",""",
"""    assistantId: "test",
    cloud: "local",
    paired: true,
    runtimeUrl: "http://127.0.0.1:1",""", 1)])

# sleep --all fixture
edit("cli/src/__tests__/sleep.test.ts", [(
"""              assistantId: "paired-one",
              runtimeUrl: "http://127.0.0.1:1",
              cloud: "paired",""",
"""              assistantId: "paired-one",
              runtimeUrl: "http://127.0.0.1:1",
              cloud: "local",
              paired: true,""", 1)])

# devices fixture
edit("cli/src/__tests__/devices.test.ts", [(
"""      runtimeUrl: "http://10.0.0.9:7830",
      cloud: "paired",
      paired: true,""",
"""      runtimeUrl: "http://10.0.0.9:7830",
      paired: true,""", 1)])

# pair.test disk fixture
edit("cli/src/__tests__/pair.test.ts", [(
"""            assistantId: "pair-test",
            runtimeUrl: RUNTIME_URL,
            cloud: "paired",""",
"""            assistantId: "pair-test",
            runtimeUrl: RUNTIME_URL,
            paired: true,""", 1)])

# teleport cadet -> cloud
edit("cli/src/__tests__/teleport.test.ts", [('cloud: "cadet"', 'cloud: "cloud"', 1)])

# wake --all fixture: flag + defaulted cloud
edit("cli/src/__tests__/wake.test.ts", [(
"""      entries[1] = {
        assistantId: "paired-one",
        runtimeUrl: "http://127.0.0.1:1",
        cloud: "paired",
      };""",
"""      entries[1] = {
        assistantId: "paired-one",
        runtimeUrl: "http://127.0.0.1:1",
        cloud: "local",
        paired: true,
      };""", 1)])

# connect-import: the written entry carries the flag now
edit("cli/src/__tests__/connect-import.test.ts", [(
'expect(entry!.cloud).toBe("paired");',
'expect(entry!.paired).toBe(true);', 1)])

# multi-local: the maker's cloud param + the gcp/aws fixtures
edit("cli/src/__tests__/multi-local.test.ts", [
    ('  cloud = "local",', '  cloud: Cloud = "local",', 1),
    ('"gcp"', '"custom"', 2),
    ('"aws"', '"custom"', 1),
])
s = open("cli/src/__tests__/multi-local.test.ts").read()
if 'import type { Cloud }' not in s:
    idx = s.index('\n', s.index('from "', s.index('import')))
    s = s[:idx+1] + 'import type { Cloud } from "@mycadet/local-mode/contract";\n' + s[idx+1:]
    open("cli/src/__tests__/multi-local.test.ts", "w").write(s)
print("multi-local import ok")

# the two seedEntry helpers (client-tui + tui-midsession)
for p in ["cli/src/__tests__/client-tui-refresh.test.ts", "cli/src/__tests__/tui-midsession-refresh.test.ts"]:
    s = open(p).read()
    m = re.search(r'function seedEntry\(cloud: string(?:, localUrl\?: string)?\): void \{\n  saveAssistantEntry\(\{\n    assistantId: "px",\n    name: "Paired",\n    runtimeUrl: RUNTIME,\n    \.\.\.\(localUrl \? \{ localUrl \} : \{\}\),\n    cloud,\n    paired: cloud === "paired",\n  \);\n\}', s)
    if not m:
        m2 = re.search(r'function seedEntry\(cloud: string\): void \{\n  saveAssistantEntry\(\{\n    assistantId: "px",\n    name: "Paired",\n    runtimeUrl: RUNTIME,\n    cloud,\n    paired: cloud === "paired",\n  \);\n\}', s)
        assert m2, p
        m = m2
    replacement = """function seedEntry(cloud: Cloud | "paired", localUrl?: string): void {
  // "paired" is not a topology: it seeds the connect-import flag on an
  // otherwise-local-defaulted entry.
  const isPaired = cloud === "paired";
  saveAssistantEntry({
    assistantId: "px",
    name: "Paired",
    runtimeUrl: RUNTIME,
""" + ("    ...(localUrl ? { localUrl } : {}),\n" if "localUrl" in m.group(0) else "") + """    ...(isPaired ? { cloud: "local" as const, paired: true } : { cloud }),
  });
}"""
    s = s.replace(m.group(0), replacement)
    if 'import type { Cloud }' not in s:
        idx = s.index('\n', s.index('from "', s.index('import')))
        s = s[:idx+1] + 'import type { Cloud } from "@mycadet/local-mode/contract";\n' + s[idx+1:]
    open(p, "w").write(s)
    print("ok", p)
