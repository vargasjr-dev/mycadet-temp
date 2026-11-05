/**
 * Transforms the cloud platform's OpenAPI spec for web app codegen.
 *
 * The checked-in `cloud.yaml` mirrors the whole mycadet-platform API — 125
 * operations, most of which this bundle never calls (admin tooling, billing
 * legs the settings pages stopped using, consents retired with their flows).
 * Shipping all of it makes the cloud client's surface a catalog of routes
 * with no caller, and every future "what calls this?" a dead end.
 *
 * So the client's surface is derived from usage, the same way knip derives
 * dead exports: an operation survives iff its camelCased operationId appears
 * somewhere in `src/` (outside `src/generated/`). Call a route and it joins
 * the client; stop calling it and the next generation drops it. No ledger to
 * maintain — the compiler and `bun run knip` police the rest.
 *
 * Referenced component schemas ride along via their `$ref` closure from the
 * kept operations, so the generated types cover exactly the surviving
 * surface.
 *
 * Output is JSON since openapi-ts accepts both formats and JSON avoids
 * needing a YAML serializer on the write side.
 *
 * Usage: bun run scripts/transform-cloud-spec.ts
 * Output: openapi-schemas/cloud.json (gitignored, consumed by openapi-ts)
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(SCRIPT_DIR, "..");
const REPO_ROOT = resolve(WEB_ROOT, "..", "..");
const SPEC_PATH = resolve(WEB_ROOT, "openapi-schemas/cloud.yaml");
const OUTPUT_PATH = resolve(WEB_ROOT, "openapi-schemas/cloud.json");
const SRC_ROOT = resolve(WEB_ROOT, "src");

/** snake_case or kebab-case operationId → the camelCase name hey-api emits. */
function toCamelCase(operationId) {
  return operationId.replace(/[_-]([a-zA-Z0-9])/g, (_, c) => c.toUpperCase());
}

/** Every word-like identifier in the source tree, excluding the generated dir. */
function collectSourceWords() {
  const words = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        if (path === resolve(SRC_ROOT, "generated")) {
          continue;
        }
        walk(path);
        continue;
      }
      if (!/\.(ts|tsx|mjs|js)$/.test(entry)) {
        continue;
      }
      const text = readFileSync(path, "utf-8");
      for (const match of text.matchAll(/[a-zA-Z_$][a-zA-Z0-9_$]*/g)) {
        words.add(match[0]);
      }
    }
  };
  walk(SRC_ROOT);
  // The tanstack plugin names its wrappers after the sdk function —
  // `useAssistantsListMutation` (hook), `assistantsListMutation`,
  // `releasesListOptions`, plus the shared key helpers — so a route called
  // only through a wrapper surfaces as a prefixed/suffixed word. Strip the
  // known wrapper affixes; each stem joins the set.
  const WRAPPER_PREFIXES = ["use"];
  const WRAPPER_SUFFIXES = [
    "MutationKey",
    "QueryKey",
    "Mutation",
    "Options",
    "Query",
  ];
  let frontier = [...words];
  for (let round = 0; round < 3 && frontier.length > 0; round++) {
    const next = [];
    for (const word of frontier) {
      for (const prefix of WRAPPER_PREFIXES) {
        if (
          word.startsWith(prefix) &&
          word.length > prefix.length &&
          word[prefix.length] === word[prefix.length].toUpperCase()
        ) {
          const stem = word.slice(prefix.length);
          if (!words.has(stem)) {
            words.add(stem);
            next.push(stem);
          }
        }
      }
      for (const suffix of WRAPPER_SUFFIXES) {
        if (word.endsWith(suffix) && word.length > suffix.length) {
          const stem = word.slice(0, -suffix.length);
          if (!words.has(stem)) {
            words.add(stem);
            next.push(stem);
          }
        }
      }
    }
    frontier = next;
  }
  return words;
}

/** Collect every internal $ref reachable from `node` (transitively). */
function collectRefs(node, into) {
  if (Array.isArray(node)) {
    for (const item of node) {
      collectRefs(item, into);
    }
    return into;
  }
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (
        key === "$ref" &&
        typeof value === "string" &&
        value.startsWith("#/components/")
      ) {
        if (!into.has(value)) {
          into.add(value);
          const [, , section, name] = value.split("/");
          const target = node.components?.[section]?.[name];
          if (target) {
            collectRefs(target, into);
          }
        }
        continue;
      }
      collectRefs(value, into);
    }
  }
  return into;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const spec = parse(readFileSync(SPEC_PATH, "utf-8"));
const sourceWords = collectSourceWords();
const componentsIn = spec.components ?? {};

const paths = spec.paths ?? {};
const keptPaths = {};
let keptOperations = 0;
let totalOperations = 0;

for (const [path, item] of Object.entries(paths)) {
  const keptItem = {};
  for (const [method, operation] of Object.entries(item)) {
    if (typeof operation !== "object" || operation === null) {
      keptItem[method] = operation;
      continue;
    }
    const operationId = operation.operationId;
    if (!operationId) {
      continue;
    }
    totalOperations += 1;
    // Stems stripped from wrapper names keep their leading capital
    // (`useAssistantsListMutation` → `AssistantsList`), so the membership
    // test is case-insensitive.
    if (
      sourceWords.has(toCamelCase(operationId)) ||
      sourceWords.has(
        toCamelCase(operationId)[0].toUpperCase() +
          toCamelCase(operationId).slice(1),
      )
    ) {
      keptItem[method] = operation;
      keptOperations += 1;
    }
  }
  if (Object.keys(keptItem).length > 0) {
    keptPaths[path] = keptItem;
  }
}

// Transitive $ref closure over the kept operations so every surviving route's
// request/response types generate, and nothing else does.
const keptComponents = {};
const queue = [...collectRefs(keptPaths, new Set())];
while (queue.length > 0) {
  const ref = queue.pop();
  const [, , section, name] = ref.split("/");
  if (keptComponents[section]?.[name]) {
    continue;
  }
  const target = componentsIn[section]?.[name];
  if (!target) {
    continue;
  }
  keptComponents[section] ??= {};
  keptComponents[section][name] = target;
  for (const nested of collectRefs(target, new Set())) {
    queue.push(nested);
  }
}
// Every flow authenticates the same way; the schemes section is small and
// dropping one the client still references breaks generation.
if (componentsIn.securitySchemes) {
  keptComponents.securitySchemes = componentsIn.securitySchemes;
}

const relativeSpec = relative(REPO_ROOT, SPEC_PATH);

const out = {
  ...spec,
  paths: keptPaths,
  ...(componentsIn ? { components: keptComponents } : {}),
};

writeFileSync(OUTPUT_PATH, JSON.stringify(out, null, 2) + "\n");

console.log(
  `transform-cloud-spec: kept ${keptOperations} of ${totalOperations} operations ` +
    `(${Object.keys(keptPaths).length} of ${Object.keys(paths).length} paths) from ${relativeSpec}`,
);
