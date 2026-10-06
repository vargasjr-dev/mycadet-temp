"use client";

import { DocsContent } from "@/app/docs/_components/docs-content";
import { SectionHeading } from "@/app/docs/_components/section-heading";
import { TableOfContents } from "@/app/docs/_components/table-of-contents";

const TOC_ITEMS = [
  { id: "platform-domains", label: "Platform Domains", level: 2 },
  { id: "assistant-runtime", label: "Assistant Runtime", level: 3 },
  { id: "native-clients", label: "Native Clients", level: 3 },
  { id: "gateway", label: "Gateway", level: 3 },
  { id: "repository-structure", label: "Repository Structure", level: 2 },
  { id: "architecture-docs", label: "Architecture Docs", level: 2 },
];

export function DeveloperGuideArchitectureContent() {
  return (
    <>
      <DocsContent title="Architecture" breadcrumb="Docs / Developer Guide / Architecture">
        <p className="mb-8 text-zinc-600">
          The Cadet Assistant platform has three main domains that work together: a runtime that manages conversations and tools,
          a native client for macOS, and a gateway that handles all external communication.
        </p>

        <section id="platform-domains">
          <SectionHeading id="platform-domains" level={2}>
            Platform Domains
          </SectionHeading>

          <section id="assistant-runtime" className="mt-6">
            <SectionHeading id="assistant-runtime" level={3}>
              Assistant Runtime
            </SectionHeading>
            <p className="mb-2 text-zinc-600">
              <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-sm dark:bg-zinc-800">assistant/</code>
            </p>
            <p className="mb-4 text-zinc-600">
              Bun + TypeScript runtime that owns conversation history, attachment storage, and channel delivery state in a local
              SQLite database. Exposes a Unix domain socket for the native client, plus an
              HTTP API consumed by the gateway.
            </p>
          </section>

          <section id="native-clients" className="mt-6">
            <SectionHeading id="native-clients" level={3}>
              Native Clients
            </SectionHeading>
            <p className="mb-2 text-zinc-600">
              <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-sm dark:bg-zinc-800">clients/</code>
            </p>
            <p className="mb-4 text-zinc-600">
              Native macOS app built with Swift via <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-sm dark:bg-zinc-800">CadetAssistantShared</code>.
              A menu bar assistant with computer-use (accessibility + CGEvent), chat, and full tool access.
            </p>
          </section>

          <section id="gateway" className="mt-6">
            <SectionHeading id="gateway" level={3}>
              Gateway
            </SectionHeading>
            <p className="mb-2 text-zinc-600">
              <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-sm dark:bg-zinc-800">gateway/</code>
            </p>
            <p className="mb-4 text-zinc-600">
              Standalone Bun + TypeScript service that serves as the public ingress boundary for all external webhooks and callbacks.
              Owns Telegram integration end-to-end (receives webhooks, routes to assistants, delivers replies). Routes Twilio voice
              webhooks, handles OAuth callbacks, and optionally acts as an authenticated reverse proxy for the assistant runtime API.
            </p>
          </section>
        </section>

        <section id="repository-structure" className="mt-12">
          <SectionHeading id="repository-structure" level={2}>
            Repository Structure
          </SectionHeading>
          <pre className="overflow-x-auto rounded-lg bg-zinc-900 p-4 text-sm text-zinc-100">
{`/
├── .github/              # GitHub Actions workflows
├── assets/               # Brand assets and images
├── assistant/            # Bun-based assistant runtime (runtime, CLI, HTTP API)
├── cli/                  # Cadet CLI
├── clients/              # Native clients (macOS, iOS, Windows, web, docs, Chrome extension)
├── credential-executor/  # Credential Execution Service (isolated RPC boundary)
├── docs/                 # Internal engineering docs and proposals
├── gateway/              # Gateway service (Telegram, Twilio, OAuth, reverse proxy)
├── meta/                 # Meta configuration
├── packages/             # Shared private packages (CES contracts, credential storage, egress proxy)
├── plugins/              # Plugin workspace (MCP catalog, marketplace)
├── scripts/              # Utility scripts (publishing, tunneling, releases)
└── skills/               # Bundled skill definitions`}
          </pre>
        </section>

        <section id="architecture-docs" className="mt-12">
          <SectionHeading id="architecture-docs" level={2}>
            Architecture Docs
          </SectionHeading>
          <p className="mb-4 text-zinc-600">
            Detailed architecture docs are split by ownership domain, close to the code:
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 dark:border-zinc-700">
                  <th className="py-2 pr-4 text-left font-medium text-zinc-900 dark:text-zinc-100">Document</th>
                  <th className="py-2 text-left font-medium text-zinc-900 dark:text-zinc-100">What&apos;s Covered</th>
                </tr>
              </thead>
              <tbody className="text-zinc-600 dark:text-zinc-400">
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-4"><a className="text-xs underline" href="/docs/developer-guide/internals/architecture">Architecture</a></td>
                  <td className="py-2">Cross-system index — invariants, domain boundaries, data flow</td>
                </tr>
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-4"><a className="text-xs underline" href="/docs/developer-guide/internals/assistant-architecture">Assistant Architecture</a></td>
                  <td className="py-2">Runtime internals — conversation loop, tool dispatch, memory, scheduling</td>
                </tr>
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-4"><a className="text-xs underline" href="/docs/developer-guide/internals/gateway-architecture">Gateway Architecture</a></td>
                  <td className="py-2">Ingress boundary — webhooks, Telegram, Twilio, reverse proxy</td>
                </tr>
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-4"><a className="text-xs underline" href="/docs/developer-guide/internals/security">Security Architecture</a></td>
                  <td className="py-2">Security model — sandbox, credentials, permissions, secret handling</td>
                </tr>
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-4"><a className="text-xs underline" href="/docs/developer-guide/internals/memory">Memory Architecture</a></td>
                  <td className="py-2">Memory system — extraction, recall, provenance gates</td>
                </tr>
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-4"><a className="text-xs underline" href="/docs/developer-guide/internals/scheduling">Scheduling Architecture</a></td>
                  <td className="py-2">Heartbeats, wake intents, and task queues</td>
                </tr>
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-4"><a className="text-xs underline" href="/docs/developer-guide/internals/integrations">Integrations Architecture</a></td>
                  <td className="py-2">How OAuth2 skills, channels, and plugins attach to the assistant</td>
                </tr>
                <tr className="border-b border-zinc-100 dark:border-zinc-800">
                  <td className="py-2 pr-4"><a className="text-xs underline" href="/docs/developer-guide/internals/turn-actor">Turn Actor Architecture</a></td>
                  <td className="py-2">How a conversation turn is routed and executed</td>
                </tr>
                <tr>
                  <td className="py-2 pr-4"><a className="text-xs underline" href="/docs/developer-guide/internals/credential-execution-service">Credential Execution Service</a></td>
                  <td className="py-2">CES — credential isolation, secure commands, RPC boundary</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      </DocsContent>
      <TableOfContents items={TOC_ITEMS} />
    </>
  );
}
