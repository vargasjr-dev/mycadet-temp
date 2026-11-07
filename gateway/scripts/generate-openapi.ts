#!/usr/bin/env bun
/**
 * Generate an OpenAPI 3.1 JSON specification from the gateway's route schemas.
 *
 * Route files export a `ROUTES` array with Zod `responseBody` / `requestBody`
 * schemas. This script imports them and calls zod-openapi's `createDocument()`.
 *
 * Usage:
 *   cd gateway && bun run scripts/generate-openapi.ts
 *   cd gateway && bun run generate:openapi
 *   cd gateway && bun run generate:openapi -- --check   # CI: fail if stale
 */

import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { format } from "prettier";
import { createDocument } from "zod-openapi";

import type { GatewayRouteDefinition } from "../src/http/routes/types.js";

// Import ROUTES from each route module. These are the SAME arrays the
// runtime dispatch table consumes (see src/http/routes/types.ts) — the
// generation script reads only the spec fields and never invokes handlers.
import { ROUTES as autoApproveThresholdRoutes } from "../src/http/routes/auto-approve-thresholds.js";
import { ROUTES as channelAdmissionPolicyRoutes } from "../src/http/routes/channel-admission-policy.js";
import { ROUTES as channelIngressRoutes } from "../src/http/routes/channel-ingress.js";
import { ROUTES as channelPermissionOverrideRoutes } from "../src/http/routes/channel-permission-overrides.js";
import { buildContactsControlPlaneRoutes } from "../src/http/routes/contacts-control-plane-route-table.js";
import { ROUTES as credentialRequestRoutes } from "../src/http/routes/credential-requests.js";
import { ROUTES as trustRuleRoutes } from "../src/http/routes/trust-rules.js";
import { ROUTES as upgradePolicyRoutes } from "../src/http/routes/upgrade-policy.js";

const ROOT = resolve(import.meta.dir, "..");
const OUTPUT_PATH = resolve(ROOT, "openapi.json");
const PKG_PATH = resolve(ROOT, "package.json");

// Collect all route definitions
const ALL_ROUTES: GatewayRouteDefinition[] = [
  ...autoApproveThresholdRoutes,
  ...channelAdmissionPolicyRoutes,
  ...channelIngressRoutes,
  ...channelPermissionOverrideRoutes,
  // The contacts table is built with stub deps: handlers are never invoked
  // during generation, only the metadata and zod schemas are read.
  ...buildContactsControlPlaneRoutes({
    contactsControlPlaneProxy: {} as never,
    handleContactPromptSubmit: async () => new Response(""),
    handleContactRecordSubmit: async () => new Response(""),
  }),
  ...credentialRequestRoutes,
  ...trustRuleRoutes,
  ...upgradePolicyRoutes,
];

// ---------------------------------------------------------------------------
// Spec builder
// ---------------------------------------------------------------------------

function buildSpec(version: string) {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const route of ALL_ROUTES) {
    // Dispatch-only, unpublished: no operationId. Raw-regex dispatch paths
    // publish under their `specPath` override instead.
    if (!route.operationId) continue;
    const specPath =
      typeof route.path === "string" ? route.path : route.specPath;
    if (!specPath) continue;
    if (!paths[specPath]) paths[specPath] = {};

    const parameters: Array<Record<string, unknown>> = [];
    if (route.pathParameters) {
      for (const param of route.pathParameters) {
        parameters.push({
          name: param.name,
          in: "path",
          required: true,
          schema: { type: "string" },
          ...(param.description ? { description: param.description } : {}),
        });
      }
    }
    if (route.queryParameters) {
      for (const param of route.queryParameters) {
        parameters.push({
          name: param.name,
          in: "query",
          required: false,
          schema: { type: "string" },
          ...(param.description ? { description: param.description } : {}),
        });
      }
    }

    const operation: Record<string, unknown> = {
      operationId: route.operationId,
      summary: route.summary,
      tags: route.tags,
    };

    if (route.description) operation.description = route.description;
    if (parameters.length > 0) operation.parameters = parameters;

    if (route.requestBody) {
      operation.requestBody = {
        required: true,
        content: {
          "application/json": { schema: route.requestBody },
        },
      };
    }

    const status = route.responseStatus ?? "200";
    if (route.responseBody) {
      operation.responses = {
        [status]: {
          description: "Successful response",
          content: {
            "application/json": { schema: route.responseBody },
          },
        },
      };
    } else {
      operation.responses = {
        [status]: { description: "Successful response" },
      };
    }

    paths[specPath][route.method] = operation;
  }

  return createDocument({
    openapi: "3.1.0",
    info: {
      title: "Cadet Gateway API",
      version,
      description:
        "Auto-generated OpenAPI specification for the Cadet Gateway HTTP endpoints.",
    },
    servers: [{ url: "", description: "Same-origin — the gateway" }],
    paths,
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const isCheck = process.argv.includes("--check");

  const pkg = JSON.parse(readFileSync(PKG_PATH, "utf-8")) as {
    version: string;
  };

  const spec = buildSpec(pkg.version);
  // Format with prettier so the committed file satisfies the repo's
  // pre-commit prettier check and `--check` byte-compares consistently.
  const output = await format(JSON.stringify(spec), { parser: "json" });

  if (isCheck) {
    let existing: string;
    try {
      existing = await readFile(OUTPUT_PATH, "utf-8");
    } catch {
      console.error(
        `${OUTPUT_PATH} does not exist. Run: bun run generate:openapi`,
      );
      process.exit(1);
    }
    if (existing !== output) {
      console.error(
        "openapi.json is stale. Regenerate: bun run generate:openapi",
      );
      process.exit(1);
    }
    console.log("openapi.json is up to date.");
    return;
  }

  await writeFile(OUTPUT_PATH, output);
  console.log(`Wrote ${OUTPUT_PATH} (${ALL_ROUTES.length} routes)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
