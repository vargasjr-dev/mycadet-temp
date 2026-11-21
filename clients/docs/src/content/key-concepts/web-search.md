How your assistant looks things up online: the six built-in providers, the fallback chain, and how each one is billed.

## Overview

Web search lets your assistant pull live information from the internet to answer questions, verify claims, and ground its responses in current sources. Whenever a conversation, scheduled task, or skill needs information that isn't in your workspace, the assistant can call out to a search provider, read the results, and cite the sources it used.

You control which provider runs that search and how it's billed. Cadet's cloud search works out of the box on your platform account, your inference provider's native search can handle it in-model, or you can connect your own API key for a dedicated search engine like Perplexity, Brave Search, Tavily, or Firecrawl.

## Providers

Six providers ship with every workspace. Cloud providers need no API key and bill through your Cadet account; BYOK providers call the vendor directly with a key you connect and bill you there.

| Provider        | Kind    | Notes                                                                                                                                                    |
| --------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cadet           | Managed | Searches run through Cadet's cloud search service. No setup, no API key. Metered from your Cadet account balance.                                        |
| Provider Native | Managed | Hands the search to the inference provider, so quality and freshness follow whichever LLM you have selected. When the selected model has no native search, the assistant falls back to any connected search key, then to Cadet's cloud search. |
| Perplexity      | BYOK    | Synthesized answers with inline citations. Default first choice in the fallback chain. Pulls from the Perplexity Search API.                              |
| Brave Search    | BYOK    | Independent index, no tracking, supports freshness filtering. Good default for privacy-leaning workspaces.                                               |
| Tavily          | BYOK    | Search API designed for AI agents. Returns scored results with extracted content blocks.                                                                 |
| Firecrawl       | BYOK    | Search plus full-page scraping. Returns clean markdown, including for JavaScript-rendered pages. One key also powers web fetch.                          |
| Exa             | BYOK    | Neural search built for AI agents. Matches on meaning and returns the most relevant passages from each page as highlights.                                |
| Serply          | BYOK    | Google search results as JSON. Returns the organic results Google ranks for the query, each with a title, link, and snippet.                              |

For each BYOK provider you connect, your assistant stores the key locally and uses it for every web search until you disconnect or switch providers. Provider privacy policies: [Perplexity](https://www.perplexity.ai/hub/legal/privacy-policy), [Brave](https://search.brave.com/help/privacy-policy), [Tavily](https://tavily.com/privacy), [Firecrawl](https://www.firecrawl.dev/privacy-policy), [Exa](https://exa.ai/privacy-policy), [Serply](https://serply.io/privacy).

## Choosing a provider

Side-by-side comparison across the dimensions that usually matter.

| Dimension         | Cadet                                    | Provider Native                       | Perplexity                                   | Brave                                   | Tavily                                        | Firecrawl                                        |
| ----------------- | ---------------------------------------- | ------------------------------------- | -------------------------------------------- | --------------------------------------- | --------------------------------------------- | ------------------------------------------------ |
| Setup             | None. Works out of the box.              | None. Works out of the box.           | API key required                             | API key required                        | API key required                              | API key required                                 |
| Billing           | Cadet credits, metered per search        | Bundled with inference (Cadet credits) | Direct to Perplexity                        | Direct to Brave                         | Direct to Tavily                              | Direct to Firecrawl                              |
| Result style      | Raw ranked results (title, URL, snippet) | Depends on the LLM you selected       | Synthesized answer with inline citations     | Raw ranked results (title, URL, snippet) | Scored results with extracted content blocks | Clean markdown, full pages included              |
| Index source      | Cadet's cloud search service             | Whatever the LLM provider uses        | Aggregates multiple search engines           | Independent crawl, not Google or Bing   | Aggregates multiple search engines            | Aggregates multiple search engines               |
| Freshness control | Supported (day / week / month / year)    | Not exposed                           | Not exposed                                  | Supported (day / week / month / year)   | Supported                                     | Supported                                        |
| Privacy           | Processed by Cadet's search infrastructure | Subject to LLM provider terms       | Standard SaaS                                | No query tracking                       | Standard SaaS                                 | Standard SaaS                                    |
| Agent ergonomics  | General-purpose search shape             | Hidden behind the LLM                 | Pre-synthesized, agent can quote directly    | General-purpose search shape            | Built for agents (scores, content blocks, raw content) | Search plus full-page scrape, reads JS-rendered pages |
| Best for          | Zero-setup search billed to one account  | Default setups, low overhead          | Cited answers in chat                        | Privacy-leaning workspaces              | Agentic workflows with extraction             | Scraping JS-heavy pages; search and fetch from one key |

If you're unsure, start on Cadet or Provider Native and switch only when you hit a concrete reason to.

## Configuring web search

Web search is configured in **Settings → AI → Web Search**.

1. Choose a **provider** from the dropdown. Cadet and Provider Native need no further setup.
2. For a BYOK provider (Perplexity, Brave, Tavily, or Firecrawl), paste your API key into the field below the dropdown. Keys are stored locally on the device that runs your assistant.
3. Optionally connect keys for more than one BYOK provider. The extras become fallbacks if the primary provider fails or runs out of quota. See [Fallback behavior](#fallback-behavior) below.

Changing the provider takes effect immediately for the next search; in-flight searches finish on the previously configured provider.

## Fallback behavior

On **Cadet**, there is no fallback: search errors (including an exhausted account balance) surface directly so your searches are never silently rerouted to a key you pay for elsewhere. On **Provider Native**, the model's own hosted search runs first, then any connected search keys, then Cadet's cloud search. On a **BYOK provider**, your assistant tries the provider you selected first; if it has no key configured or its request fails with a retryable error, the daemon walks the fallback chain in this order:

1. Perplexity
2. Brave Search
3. Tavily
4. Firecrawl

The chain skips any provider that doesn't have a key connected. If none of them have keys, the search returns an error and the assistant tells you it couldn't reach the web. Connecting more than one BYOK key is the simplest way to keep search resilient when an upstream provider has an outage.

## Billing

Web search is one of four chargeable categories in the Cadet platform, alongside LLM inference, image generation, and paid third-party APIs.

- On **Cadet**, each search is metered from your Cadet account balance.
- On **Provider Native**, search cost is bundled into the inference call that triggered it. You pay Cadet credits the same way you pay for any other LLM request.
- On a **BYOK provider**, the search vendor bills you directly under your account with them. Cadet doesn't mark up or proxy these requests.
