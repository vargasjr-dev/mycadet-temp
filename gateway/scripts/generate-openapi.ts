#!/usr/bin/env bun
/**
 * Generate an OpenAPI 3.1 JSON specification from the gateway's route schemas.
 *
 * The gateway server owns the routes barrel (`src/http/routes/index.ts`);
 * this script imports the SAME `ROUTES` array the runtime dispatch table
 * consumes and calls zod-openapi's `createDocument()`. Handlers are never
 * invoked here — only the spec fields and zod schemas are read.
 *
 * Usage:
 *   cd gateway && bun run scripts/generate-openapi.ts
 *   cd gateway && bun run generate:openapi
 *   cd gateway && bun run generate:openapi -- --check   # local drift check
 *
 * The spec is not checked in — the web codegen pipeline regenerates it.
 */

import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { format } from "prettier";
import { createDocument } from "zod-openapi";

import { ROUTES } from "../src/http/routes/index.js";
import { regexToOpenApiPath } from "../src/http/routes/regex-to-openapi-path.js";

const ROOT = resolve(import.meta.dir, "..");
const OUTPUT_PATH = resolve(ROOT, "openapi.json");
const PKG_PATH = resolve(ROOT, "package.json");

// ---------------------------------------------------------------------------
// Spec builder
// ---------------------------------------------------------------------------

function buildSpec(version: string) {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const route of ROUTES) {
    // Dispatch-only, unpublished: no operationId.
    if (!route.operationId) continue;
    const specPath =
      typeof route.path === "string"
        ? route.path
        : regexToOpenApiPath(route.path);
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
  console.log(`Wrote ${OUTPUT_PATH} (${ROUTES.length} routes)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
