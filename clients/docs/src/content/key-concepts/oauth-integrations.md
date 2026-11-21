How Cadet connects to third-party services via OAuth2, what services are supported, and how your credentials stay secure.

## Overview

Cadet connects to external services through OAuth2 integrations. Instead of copying API keys into chat, you authorize your assistant once through a standard browser-based OAuth flow. The resulting access token is stored securely in your local credential vault, and your assistant can call the service's APIs on your behalf whenever a task requires it.

Each integration is exposed as a bundled skill with its own set of tools. For example, connecting Gmail gives your assistant tools like `gmail_send`, `gmail_search`, and `gmail_archive`. Connecting Google Calendar adds event creation, listing, and update tools. You decide which integrations to connect, and you can revoke access at any time.

## Supported services

The following integrations ship with every Cadet workspace and connect via OAuth2 unless noted otherwise.

| Service            | Auth type | What you can do                                            | Notes                                                                          |
| ------------------ | --------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Discord            | OAuth2    | Send messages, read channels, manage servers               | Server-level. The bot must be added to each server you want to access.         |
| GitHub             | OAuth2    | Read repos, open issues, review PRs, manage labels, star repos | Requires the repo and read:user scopes. Private repos accessible if granted. |
| Google             | OAuth2    | Gmail, Calendar, Drive, Docs, Sheets, Slides, and Contacts | Single OAuth connection covers all Google services. Can be revoked in Google Account settings. |
| HubSpot            | OAuth2    | CRM contacts and deals                                     | CRM-scoped. Access follows your HubSpot user permissions.                      |
| Linear             | OAuth2    | Issues and projects                                        | Organization-scoped. Access follows your Linear role permissions.              |
| Twitter (X)        | OAuth2    | Posts and direct messages                                  | Paid. Per-call billing through Cadet credits at the cloud rate.                |
| Asana              | OAuth2    | Tasks and projects                                         | Workspace-scoped. Access follows your Asana workspace permissions.             |
| Notion             | OAuth2    | Pages and databases                                        | Integration must be added to specific Notion pages to access them.             |
| Outlook / Microsoft| OAuth2    | Email and calendar                                         | Microsoft 365 OAuth. Covers Outlook email and calendar events.                 |
| Todoist            | OAuth2    | Tasks and projects                                         | Project-scoped. Access follows your Todoist project permissions.               |

New integrations are added regularly. If a service you need isn't listed, you can often connect it via a custom skill using its API key, or request it through the [roadmap](https://www.mycadet.ai/roadmap).

## Connecting an integration

The fastest way to connect a service is to ask your assistant directly:

```
"Connect my Gmail"
```

Alternatively, you can connect through the Settings UI:

1. Open **Settings** in your Cadet app.
2. Navigate to the **Integrations** or **Services** tab.
3. Find the service you want to connect and click **Connect**.
4. Complete the OAuth flow in the browser window that opens.
5. Return to Cadet. The integration status should show **Connected**.

You can disconnect an integration at any time through the same Settings panel, or by asking your assistant to disconnect it for you. Disconnecting deletes the stored token from your local vault immediately.

## Security model

OAuth tokens are handled with the same security model as API keys and passwords:

- **Local vault:** Tokens are stored in your workspace's local credential vault, not on Cadet's servers. The cloud never sees them.
- **LLM isolation:** The LLM never receives raw tokens. When a skill needs to call an API, the daemon retrieves the token and injects it into the HTTP request at the transport layer.
- **Scoped permissions:** Cadet requests the minimum OAuth scopes required for each service. You can review the exact scopes on the integration's detail page before connecting.
- **Revocation:** Disconnecting an integration in Cadet deletes the local token. You can also revoke access from the third-party service's own settings page (e.g., Google Account permissions) for an additional layer of control.

For more details on the credential vault and permissions model, see [The Permissions Model](/docs/trust-security/the-permissions-model).

## Billing

OAuth integrations fall into three billing categories:

| Category             | What it covers                                                                                        | Who pays                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| Cloud OAuth (free)   | Services where Cadet manages the OAuth app registration (Discord, GitHub, Google, HubSpot, Linear, Asana, Notion, Outlook, Todoist) | No additional cost. These integrations are bundled with your Cadet workspace. |
| Cloud OAuth (billed) | Twitter (X) — Cadet manages the OAuth app, but the underlying API usage is billed per call.            | API calls are billed through Cadet credits at the cloud rate.       |
| BYOK OAuth           | Services where you register your own OAuth app (e.g., custom Twitter API tier, enterprise Google Workspace) | You pay the third-party service directly under your own account and quota. |

Most integrations (GitHub, Notion, Linear, Google, Discord, Asana, Outlook, Todoist, and HubSpot) are cloud OAuth with no additional cost. Only Twitter (X) cloud OAuth incurs per-call billing through Cadet credits. BYOK is for advanced cases where you bring your own API keys or enterprise OAuth apps.

## Troubleshooting

Common issues and how to fix them:

- **OAuth connection failed:** If you are on a corporate network, your IT team may block third-party OAuth. Ask them to whitelist the service's OAuth domain, or connect from a personal network.
- **Token expired:** OAuth tokens expire. Tell your assistant to reconnect the service (e.g., *"Reconnect my Gmail"*) and it will walk you through the authorization flow again.
- **Insufficient permissions:** If a skill says it can't perform an action (e.g., sending from a specific Gmail label), the OAuth scope may not cover it. Disconnect and reconnect, ensuring you grant all requested permissions during the flow.
- **Rate limited:** Some services enforce strict API rate limits (notably Twitter/X). If you hit limits, the assistant will tell you. You may need to upgrade your API tier with the service directly.
