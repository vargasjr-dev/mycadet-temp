<p align="center">
  <img src="assets/cadet-banner.png" alt="Cadet" width="100%">
</p>

<p align="center">
  <a href="https://mycadet.ai/docs"><img src="https://img.shields.io/badge/Docs-mycadet.ai%2Fdocs-FFD700?style=for-the-badge" alt="Documentation"></a>
  <a href="https://mycadet.ai/community"><img src="https://img.shields.io/badge/Community-mycadet.ai%2Fcommunity-5865F2?style=for-the-badge" alt="Community"></a>
  <a href="https://github.com/vargasjr-dev/mycadet-temp/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-MIT-green?style=for-the-badge" alt="License: MIT"></a>
  <a href="https://mycadet.ai"><img src="https://img.shields.io/badge/Built%20by-Vargas%20JR%20LLC-blueviolet?style=for-the-badge" alt="Built by Vargas JR LLC"></a>
</p>

<p align="center"><b>A personal AI assistant that evolves with you.</b><br>
8 different types of memory (episodic, semantic, procedural, emotional, prospective, behavioral, narrative, shared) make it truly yours. It learns how you work, remembers what matters, and takes action across your apps.</p>

---

## What It Does

Cadet is a personal AI assistant that learns how you work, remembers what matters, and takes action across your apps.
| Area                          | Summary |
| ----------------------------- | --- |
| **Memory**                    | Eight types (episodic, semantic, procedural, emotional, prospective, behavioral, narrative, shared), each with its own staleness window, hybrid dense + sparse retrieval, and per-user and per-channel isolation. Structured items (identity, preferences, projects, events) extracted from conversations with source attribution and dedup. Embeddings run locally by default. Not a SQLite + Markdown file you maintain yourself. |
| **Identity**                  | Behavior lives in SOUL.md. During onboarding the assistant observes how you communicate and writes its own personality files. It keeps a per-user journal of reflections and uses NOW.md as a scratchpad for current focus and active threads. |
| **Proactivity**               | Every hour the assistant re-reads its notes, looks for anything unfinished or due soon, and messages you if something needs attention. Notifications go to the right channel and won't interrupt an active conversation. |
| **Security**                  | Actor identity (guardian, trusted, unknown) is resolved once and enforced everywhere; unknown actors can't read memory, trigger tools, or escalate. Credentials live in a separate process and never reach the model. Every tool call runs in a sandbox. The default is to deny. |
| **Channels**           | macOS, Windows, iOS, Web, Voice, Email, Telegram, Slack, Twilio. One assistant, one memory, every channel. |
| **OAuth**             | Slack, Notion, Google, HubSpot, Linear, Discord, Twitter, Telegram, Twilio. No hand-rolled token refresh. |
| **Hosting**      | Managed runtime on Cadet Platform, or self-hosted. Same codebase, same data model. |

---

## Get Started

**1. [Sign up](https://mycadet.ai/signup) or [download the app](https://mycadet.ai/downloads)**

The desktop app is available for macOS and Windows. The Windows download is currently a dev build connected to the development environment, with x64 (Intel/AMD) and ARM64 installers. See the [installation guide](https://mycadet.ai/docs/getting-started/installation) for setup and permissions.

**2. Pick your mode**

- **Managed**: sign in via Cadet Platform, no local runtime required
- **Local**: everything runs on your machine

**3. Hatch your assistant**

- It's yours! Have fun with it.

<sub>Prefer the terminal? See <a href="#cli">CLI install</a> below.</sub>

---

## Quick Demo

<p align="center">
  <img src="assets/quick-demo.gif" alt="Cadet demo" width="100%">
</p>

---

## CLI

<details open>
<summary>Install and common commands</summary>

<br>

The CLI works but the desktop app is our primary focus. Available for advanced users, contributors, and terminal-based workflows. The Windows desktop app installs the bundled CLI for your user account on first launch; open a new terminal afterward to use `cadet`.

**Install**

```bash
bun install -g cadet
cadet hatch
```

**Install from source**

```bash
git clone https://github.com/vargasjr-dev/mycadet-temp.git
cd mycadet-temp
./setup.sh
source ~/.bashrc
cadet hatch
```

**Common commands**

```bash
cadet wake        # start services
cadet sleep       # stop services, keep data
cadet client      # interact through the terminal
cadet ps          # view running assistants
cadet terminal    # open a shell into a managed assistant container
cadet upgrade     # upgrade to latest version
```

All commands target the default assistant. If you have multiple, pass the assistant ID as the second argument.

**Guides**

- [Pair a device](https://mycadet.ai/docs/hosting-options/pair-a-device): reach a self-hosted assistant from your phone or another computer by opening a tunnel and pairing the device.

</details>

---

## Infra and security

| Area                       | Summary                                                                                                                                                                                                                                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Computer use**           | The assistant works in its own sandbox, and with your approval reaches your actual machine: reads and edits files, runs commands, drives the browser. Every action is permission-gated, and you can grant once, for ten minutes, or always. |
| **Skills**                 | Plugins defined by a SKILL.md and a TOOLS.json that add tools and prompt sections at runtime, sandboxed like everything else. Install them from the catalog, bundle them, or drop them in the workspace.                                                                                      |
| **Channels**               | One assistant with one memory, reachable from the macOS or Windows app, Telegram, or Slack. Start a thought in one channel and pick it up in another.                                                                                                                                                              |
| **Multi-provider support** | Works with Anthropic, OpenAI, Google Gemini, Fireworks, OpenRouter, MiniMax, [Atlas Cloud](https://www.atlascloud.ai/?utm_source=github&utm_medium=link&utm_campaign=cadet), and any OpenAI-compatible endpoint. Local models run through Ollama. Embeddings run on local ONNX by default and fall back to cloud providers automatically.                                                                                    |

---

## Foundational documents

The canonical sources for who we are and how we talk about what we're building. The docs site at [mycadet.ai/docs](https://mycadet.ai/docs) is a rendered view of these files.

| Doc                             | What it is                                                       |
| ------------------------------- | ---------------------------------------------------------------- |
| [Constitution](CONSTITUTION.md) | Who we are, what we believe, and what we refuse to compromise on |
| [Glossary](GLOSSARY.md)         | The shared vocabulary we use to talk about personal intelligence |

---

## Documentation

| Section                                                                             | What's covered                                                     |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| [Architecture](https://mycadet.ai/docs/developer-guide/architecture)                 | Platform domains, repo structure, runtime · clients · gateway      |
| [Security & Permissions](https://mycadet.ai/docs/developer-guide/security)           | Sandbox, credentials, trust rules, permission modes                |
| [Features & Capabilities](https://mycadet.ai/docs/developer-guide/features)          | Integrations, dynamic skills, browser, attachments, media embeds   |
| [API & Communication](https://mycadet.ai/docs/developer-guide/api)                   | SSE event stream, event payloads, remote access                    |
| [Development Workflow](https://mycadet.ai/docs/developer-guide/development-workflow) | Claude Code commands, parallel PRs, review loops, release pipeline |

📖 **[Full documentation →](https://mycadet.ai/docs)**

---

## Contributing

We welcome contributions from everyone.

- **Development**: The [contributing guide](CONTRIBUTING.md) will help you get started.
- Make sure to check out our [Code of Conduct](CODE_OF_CONDUCT.md).

## Community

- 🐛 [Issues](https://github.com/vargasjr-dev/mycadet-temp/issues)

## License

MIT. See [License](https://github.com/vargasjr-dev/mycadet-temp?tab=MIT-1-ov-file). Integration logos from [Simple Icons](https://github.com/simple-icons/simple-icons), licensed [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/).

Cadet is open-source software built by [Vargas JR LLC](https://mycadet.ai). Based on the Vellum Assistant by Vellum AI, used under the MIT license. Free to use and modify under MIT, and we're committed to keeping it that way.

---

<p align="center">Built with 💚 by <a href="https://mycadet.ai">Vargas JR LLC</a></p>
