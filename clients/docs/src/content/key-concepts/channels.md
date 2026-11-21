A channel is how you talk to your assistant. Your assistant is the same everywhere — same personality, same memories, same skills. The only thing that changes is where you're talking to it and what the channel can do.

## Web

The browser experience. Sign in at your Cadet Cloud URL and you're talking to your assistant in seconds, no install required. Works on any modern browser, any device.

- **Chat** — full conversational UI with cards, tables, forms, and other rich surfaces
- **About your assistant** — browse identity, skills, workspace files, contacts, and memories
- **Document editor** — long-form writing with your assistant as collaborator
- **App viewer** — interactive apps your assistant builds render right in the page
- **Voice input** — press to talk using your browser's microphone
- **Approvals** — native in-page permission prompts, same as the desktop app

Web is cloud-only by design — the assistant runs in your Cadet Cloud account, with the workspace and sandbox living there. The browser doesn't have access to your local machine, so host file access, shell commands, computer use, and screen watch aren't available here. For those, use the desktop app.

## Desktop App

The desktop experience is available on macOS and Windows, with a menu bar presence on Mac and a system tray icon on Windows:

- **Chat** — type messages, see responses, interact with cards, tables, and other UI surfaces
- **Computer use** — your assistant can see your screen and control your Mac or Windows PC directly
- **Voice input**: use the in-app voice controls or configure your voice shortcut in Settings
- **Document editor** — long-form writing with your assistant as collaborator
- **App viewer** — interactive apps your assistant builds render right in the window
- **Screen watch** — your assistant can observe what you're doing and offer context-aware help
- **Host file & shell access** — your assistant can read files and run commands on your machine

Some features depend on the operating system. The Fn voice key and floating companion are macOS-only. Windows uses a configurable voice mode shortcut and supports computer control in normal, non-elevated windows. See [Windows system permissions](/docs/trust-security/the-permissions-model#windows-system-permissions).

## iOS

The pocket experience. The Cadet app on iPhone and iPad signs into your Cadet Cloud account and gives you the same assistant you talk to on the web and desktop, with the same memory and the same conversations carried across.

- **Chat anywhere** — full conversational UI on the go
- **Conversation continuity** — pick up where you left off on Mac or web; history is shared
- **Push notifications** — your assistant can reach you when something needs your attention
- **Approvals** — native iOS prompts when a tool call needs your go-ahead

Like Web, iOS is cloud-only by design. The assistant runs in your Cadet Cloud account, so host file access, shell commands, computer use, and screen watch live with the desktop app.

Available on the [App Store](https://apps.apple.com/us/app/mycadet/id6759934423) for iPhone and iPad.

## Android

The Android app is the same kind of pocket client as iOS: it signs into your Cadet Cloud account and carries the same assistant, memory, and conversations. Host file access, shell commands, computer use, and screen watch stay on the desktop app.

Available on [Google Play](https://play.google.com/store/apps/details?id=ai.mycadet.android).

## CLI

A command-line interface for interacting with your assistant from the terminal. Uses the same SSE streaming connection as the desktop app — meaning it's a full interactive interface, not just a dumb pipe.

Permission approval prompts work natively in the CLI, and all sandbox-based skills are available. Useful for scripting, automation, or if you prefer working in a terminal.

## Telegram

Connect a Telegram bot to your assistant and message it from anywhere. Setup takes a few minutes:

1. Create a bot via BotFather
2. Give your assistant the bot token
3. Your assistant registers the webhook automatically

From there, you can chat with your assistant in Telegram like any other contact. It supports text, images, documents, and interactive inline buttons for approvals. When your assistant needs permission to do something, it sends an inline keyboard you can tap.

Telegram works in private chats and in groups. In a group, your assistant answers when a message mentions it or replies to one of its posts, and stays out of the rest of the conversation. Broadcast channels are not supported.

Telegram is also one of the channels your assistant can use to reach you — notifications, follow-ups, and alerts can all land in your Telegram chat.

## Slack

Connect your assistant to Slack workspaces via Socket Mode. It can:

- Respond to @mentions in channels
- Hold threaded conversations
- Send rich messages with Block Kit formatting
- Handle approvals via interactive buttons
- Send ephemeral messages (visible only to you) for sensitive prompts

Slack has a unique feature: **per-channel permission profiles**. You can configure which tool categories are allowed in which Slack channels, block specific tools, and set trust level overrides. For example, an engineering channel might allow coding and terminal tools, while a general channel restricts them to `restricted` trust.

Notifications are delivered to Slack, and invite code redemption is supported for onboarding new contacts via Slack.

## Email

Email works in two distinct modes: managing **your email** and giving the assistant **its own inbox**.

### Your email (Gmail)

Connect your Gmail account via Google OAuth and your assistant becomes a full email manager. This is what happens when you say "check my email" or "clean up my inbox" — it defaults to your Gmail, not the assistant's own address.

- Read, search, and triage your inbox
- Draft and send emails on your behalf (draft-first workflow — nothing sends without your approval)
- Archive, label, trash, and organize messages
- Unsubscribe from mailing lists
- Bulk declutter with sender digest scanning
- Create inbox filters for automation
- Manage attachments, forwarding, and follow-up tracking
- Vacation auto-responder

Gmail is also a cloud in the unified messaging system — your assistant can read, search, and send across Gmail, Telegram, and other connected platforms through a single interface.

### Assistant's own email (AgentMail)

Your assistant can also have its own email address. This is behind a feature flag (`email-channel`) and uses a provider-agnostic architecture — currently backed by AgentMail.

- Receive and process inbound emails to the assistant's address
- Draft, approve, and send outbound emails as the assistant
- Thread-aware conversations
- Custom domain setup with DNS verification
- Invite code redemption for onboarding contacts

Outbound notification delivery is not currently enabled on the assistant's email. Conversations use the `continue_existing_conversation` strategy, meaning replies stay in the same thread.

## Phone Calls

Your assistant can make and receive phone calls via Twilio.

- **Inbound calls** — callers reach your assistant's phone number, and it answers with real-time voice conversation powered by ElevenLabs text-to-speech
- **Outbound calls** — your assistant can call people on your behalf (for example, during guardian verification)
- **Transcripts** — call recordings are transcribed and stored as conversation history

Phone is the most constrained channel. Notifications cannot be delivered to it, invite code redemption is not supported, and conversations are `not_deliverable` — meaning the assistant can't initiate a message to a phone number outside of an active call. Setup requires a Twilio account and a provisioned phone number.

## Channels vs. interfaces

Internally, the system distinguishes between **channels** and **interfaces**.

**Channels** are the six communication transports: `cadet`, `telegram`, `slack`, `email`, and `phone`. Every message has a channel.

**Interfaces** are more specific — they include the channels plus the specific clients used to send the message. The `cadet` channel has four interfaces: `macos` (the desktop app), `web` (the browser), `ios` (the iPhone and iPad app), and `cli` (the terminal). A message on the `cadet` channel might come from any of these — the interface tells the system which one.

The distinction matters for capabilities. The macOS, web, iOS, and CLI interfaces are **interactive** — they have an SSE client capable of displaying native permission prompts. Channel interfaces (Telegram, Slack, etc.) route approvals through the guardian system instead.

## What works where

Not every channel can do everything. Here's what to expect:

| Capability           | Web          | Desktop | iOS        | CLI          | Telegram         | Slack              | Email     | Phone     |
| -------------------- | ------------ | ------- | ---------- | ------------ | ---------------- | ------------------ | --------- | --------- |
| **Chat**             | Yes          | Yes     | Yes        | Yes          | Yes              | Yes                | Yes       | Voice     |
| **Computer use**     | —            | Yes     | —          | —            | —                | —                  | —         | —         |
| **Host file/shell**  | —            | Yes     | —          | —            | —                | —                  | —         | —         |
| **Screen watch**     | —            | Yes     | —          | —            | —                | —                  | —         | —         |
| **Voice input**      | Yes          | Yes     | —          | —            | —                | —                  | —         | Yes       |
| **Approvals**        | Native prompt | Native prompt | Native prompt | Native prompt | Inline buttons | Interactive buttons | Plain text | — |
| **Rich content**     | Full UI      | Full UI | Mobile UI  | Text         | Markdown + media | Block Kit          | HTML      | Voice only |
| **Notifications**    | Yes          | Yes     | Yes        | Yes          | Yes              | Yes                | —         | —         |
| **Invite codes**     | —            | —       | —          | —            | Yes              | Yes                | Yes       | —         |
| **Skills**           | All (cloud)  | All     | All (cloud) | All         | All              | All (with channel permissions) | All | Limited |

Your assistant adapts its output to what the channel supports. If it would normally show you an interactive card, it'll send plain text on Telegram or speak it on a phone call instead.

## Same assistant, everywhere

Your assistant's identity, personality, and memory are channel-independent. A conversation that starts on your desktop can be followed up on Telegram. A fact you share over a phone call is remembered in Slack.

What ties it together is the guardian system — covered in the next section.

## The guardian

The **guardian** is you — the primary owner of the assistant. Guardians have full access to memories, workspace files, tools, and credentials, and are the only ones who can grant approval for sensitive actions. Channels are how the guardian system stretches that trust across the places you actually live.

Three things the guardian system does on every channel:

- **Verifies who's talking.** The first time you message your assistant on a new channel, you go through a short challenge-response flow that links that channel identity (your Telegram chat ID, Slack handle, phone number, email address) to your guardian account. Once verified, the assistant trusts that messages from there are coming from you.
- **Routes approvals.** When the assistant needs permission to do something sensitive, it asks the guardian. On interactive channels (web, desktop, CLI) the prompt appears inline. On other channels (Telegram, Slack, email), the approval is sent through the channel itself — you reply there to allow or deny. Approvals routed through a channel are always downgraded to one-time grants.
- **Gates memory extraction.** Long-term memories are only extracted from messages by trusted guardians. Messages from contacts or unverified parties are indexed for search inside that conversation but can't reshape what your assistant knows about you.

Multiple channels can point to the same guardian. Once your Telegram, Slack, phone, and email are all linked to your account, your assistant treats them as one person across conversations. For the full model and how trust rules work, see [The permissions model](/docs/trust-security/the-permissions-model).

## Setting up channels

Web and desktop don't need setup beyond signing in to your Cadet Cloud account (or installing the app, for desktop). Other channels are configured through your assistant. You can say things like:

- "Set up Telegram"
- "Connect to Slack"
- "Set up voice"
- "Provision a phone number"

Your assistant walks you through the setup conversationally — providing API keys, authorizing OAuth, configuring webhooks — rather than through a separate settings panel. Each channel has its own setup skill that handles the end-to-end flow.

Some channels require external service accounts (Twilio for phone, BotFather for Telegram). Your assistant will guide you through creating those when needed.
