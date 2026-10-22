"""Remove the cadet CLI's 4 billing cloud commands (credits/subscription/plans/invoices)."""

import json, subprocess

BASE = "assistant/src/cli/commands/cloud"


def read(p):
    with open(p) as f:
        return f.read()


def write(p, s):
    with open(p, "w") as f:
        f.write(s)


def cut(src, start, end, label):
    assert src.count(start) == 1, f"{label}: start count != 1 ({src.count(start)})"
    i = src.index(start)
    j = src.index(end, i)
    assert i < j, f"{label}: bad order"
    return src[:i] + src[j:]


# ---- index.ts ----
p = f"{BASE}/index.ts"
src = read(p)
orig = len(src)

# imports: drop credits-format + invoices
src = cut(
    src,
    'import {\n  type CloudCreditsResult,\n  formatCreditsLines,\n} from "./credits-format.js";\n',
    'import { registerCloudDisconnectCommand } from "./disconnect.js";\n',
    "credits-format import",
)
src = cut(
    src,
    'import { registerCloudInvoicesCommands } from "./invoices.js";\n',
    "\ninterface CloudStatusResult",
    "invoices import",
)

# drop CloudSubscriptionResult + CloudPlansResult interfaces (keep CloudStatusResult)
src = cut(
    src,
    "interface CloudSubscriptionResult",
    "export function registerCloudCommand",
    "billing result interfaces",
)

# drop the credits/subscription/plans action blocks + the invoices registration
src = cut(
    src,
    "      // -----------------------------------------------------------------------\n      // credits\n",
    "      // -----------------------------------------------------------------------\n      // disconnect\n",
    "billing command blocks",
)
write(p, src)
print(f"index.ts: -{orig - len(src)} chars")

# ---- index.help.ts ----
p = f"{BASE}/index.help.ts"
src = read(p)
orig = len(src)

# helpText examples: drop the 4 billing lines
for line in [
    "  $ assistant cloud credits --json\n",
    "  $ assistant cloud subscription --json\n",
    "  $ assistant cloud plans --json\n",
    "  $ assistant cloud invoices list --json\n",
]:
    assert src.count(line) == 1, f"example line missing: {line!r}"
    src = src.replace(line, "")

# drop the credits/subscription/plans/invoices subcommand entries
src = cut(
    src,
    '    {\n      name: "credits",',
    '    {\n      name: "disconnect",',
    "billing subcommand entries",
)
write(p, src)
print(f"index.help.ts: -{orig - len(src)} chars")

# ---- delete the billing command + test files ----
for f in [
    f"{BASE}/credits-format.ts",
    f"{BASE}/invoices.ts",
    f"{BASE}/__tests__/credits-format.test.ts",
    f"{BASE}/__tests__/credits.test.ts",
    f"{BASE}/__tests__/invoices.test.ts",
    f"{BASE}/__tests__/plans.test.ts",
    f"{BASE}/__tests__/subscription.test.ts",
]:
    subprocess.run(["git", "rm", "-q", f], check=True)
    print(f"deleted {f}")

# ---- assertions: kept commands still wired, billing gone ----
idx = read(f"{BASE}/index.ts")
for needle in [
    "registerCloudConnectCommand(platform);",
    "subcommand(platform, \"status\")",
    "registerCloudDisconnectCommand(platform);",
    "cloud_callback_routes_register",
    "platform_callback_routes_list",
    "interface CloudStatusResult",
]:
    assert needle in idx, f"missing keep in index.ts: {needle}"
for needle in [
    "credits",
    "subscription",
    "plans",
    "invoices",
    "CloudCreditsResult",
    "CloudSubscriptionResult",
    "CloudPlansResult",
    "formatCreditsLines",
    "registerCloudInvoicesCommands",
]:
    assert needle not in idx, f"residual in index.ts: {needle}"
help_src = read(f"{BASE}/index.help.ts")
for needle in ['name: "connect"', 'name: "status"', 'name: "disconnect"', 'name: "callback-routes"']:
    assert needle in help_src, f"missing keep in help: {needle}"
for needle in ['name: "credits"', 'name: "subscription"', 'name: "plans"', 'name: "invoices"']:
    assert needle not in help_src, f"residual in help: {needle}"
print("assertions passed")
