<p align="center">
  <img src="assets/cadet-banner.png" alt="Cadet" width="100%">
</p>

<p align="center">
  <a href="https://mycadet.ai/docs"><img src="https://img.shields.io/badge/Docs-mycadet.ai%2Fdocs-FFD700?style=for-the-badge" alt="Documentation"></a>
  <a href="https://mycadet.ai/community"><img src="https://img.shields.io/badge/Community-mycadet.ai%2Fcommunity-5865F2?style=for-the-badge" alt="Community"></a>
  <a href="https://github.com/vargasjr-dev/mycadet-temp/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-MIT-green?style=for-the-badge" alt="License: MIT"></a>
  <a href="https://mycadet.ai"><img src="https://img.shields.io/badge/Built%20by-Vargas%20JR%20LLC-blueviolet?style=for-the-badge" alt="Built by Vargas JR LLC"></a>
</p>

<p align="center"><b>A personal AI assistant that evolves with you.</b></p>

## Quick Demo

<p align="center">
  <img src="assets/quick-demo.gif" alt="Cadet demo" width="100%">
</p>

## 3 ways to get started

1. [Sign up](https://mycadet.ai/signup)
2. [Download the app](https://mycadet.ai/downloads)
3. [Install via the CLI](https://mycadet.ai/docs/getting-started/installation)

## Infra and security

| Area                       | Summary                                                                                                                                                                                                                                                                                                                                   |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Computer use**           | The assistant works in its own sandbox, and with your approval reaches your actual machine: reads and edits files, runs commands, drives the browser. Every action is permission-gated, and you can grant once, for ten minutes, or always.                                                                                               |
| **Skills**                 | Plugins defined by a SKILL.md and a TOOLS.json that add tools and prompt sections at runtime, sandboxed like everything else. Install them from the catalog, bundle them, or drop them in the workspace.                                                                                                                                  |
| **Channels**               | One assistant with one memory, reachable from the macOS or Windows app, Telegram, or Slack. Start a thought in one channel and pick it up in another.                                                                                                                                                                                     |
| **Multi-provider support** | Works with Anthropic, OpenAI, Google Gemini, Fireworks, OpenRouter, MiniMax, [Atlas Cloud](https://www.atlascloud.ai/?utm_source=github&utm_medium=link&utm_campaign=cadet), and any OpenAI-compatible endpoint. Local models run through Ollama. Embeddings run on local ONNX by default and fall back to cloud providers automatically. |

## Foundational documents

The canonical sources for who we are and how we talk about what we're building. The docs site at [mycadet.ai/docs](https://mycadet.ai/docs) is a rendered view of these files.

| Doc                             | What it is                                                       |
| ------------------------------- | ---------------------------------------------------------------- |
| [Constitution](CONSTITUTION.md) | Who we are, what we believe, and what we refuse to compromise on |
| [Glossary](GLOSSARY.md)         | The shared vocabulary we use to talk about personal intelligence |

## Documentation

| Section                                                                              | What's covered                                                     |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| [Architecture](https://mycadet.ai/docs/developer-guide/architecture)                 | Platform domains, repo structure, runtime · clients · gateway      |
| [Security & Permissions](https://mycadet.ai/docs/developer-guide/security)           | Sandbox, credentials, trust rules, permission modes                |
| [Features & Capabilities](https://mycadet.ai/docs/developer-guide/features)          | Integrations, dynamic skills, browser, attachments, media embeds   |
| [API & Communication](https://mycadet.ai/docs/developer-guide/api)                   | SSE event stream, event payloads, remote access                    |
| [Development Workflow](https://mycadet.ai/docs/developer-guide/development-workflow) | Claude Code commands, parallel PRs, review loops, release pipeline |

📖 **[Full documentation →](https://mycadet.ai/docs)**

## Contributing

We welcome contributions from everyone.

- **Development**: The [contributing guide](CONTRIBUTING.md) will help you get started.
- Make sure to check out our [Code of Conduct](CODE_OF_CONDUCT.md).

## Community

- 💬 [Community](https://mycadet.ai/community)
- 🐛 [Issues](https://github.com/vargasjr-dev/mycadet-temp/issues)

## License

MIT. See [License](https://github.com/vargasjr-dev/mycadet-temp?tab=MIT-1-ov-file). Integration logos from [Simple Icons](https://github.com/simple-icons/simple-icons), licensed [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/).

Cadet is open-source software built by [Vargas JR LLC](https://vargasjr.dev). Based on the Vellum Assistant by Vocify Inc, used under the MIT license. Free to use and modify under MIT, and we're committed to keeping it that way.
