Cadet is a personal AI assistant that lives in the secure Cadet Cloud, available wherever you are. It can have its own identity, its own email, its own accounts, its own logins. It can read your files, manage your calendar, order you food, build you an app, control your computer, take calls on your behalf, and remember that you take your coffee black. It's not a chatbot. It's a separate entity that works for you, learns about you, and takes real actions in the real world.

This page covers everything to get from zero to a working assistant: what Cadet is, how to install it, how to start using it, and how to teach it its first new skill.

## What is Cadet?

### The short version

Cadet is a personal AI assistant that lives in the secure Cadet Cloud, available wherever you are. It can have its own identity, its own email, its own accounts, its own logins. It can read your files, manage your calendar, order you food, build you an app, control your computer, take calls on your behalf, and remember that you take your coffee black.

It's not a chatbot. It's not an autocomplete engine. It's a separate entity that works for you, learns about you, and takes real actions in the real world.

### How is this different from ChatGPT, Claude, OpenClaw, or Hermes?

Those are conversation tools. You type, they respond, you copy-paste the answer somewhere useful. The conversation ends and everything resets.

Cadet is different in a few important ways:

**It has tools, not just words.** Your assistant can browse the web, read your files, run code, send emails, manage your calendar, and interact with dozens of services. It can also see your screen and control your Mac or Windows PC directly, clicking, typing, and navigating apps through the desktop app. Sensitive actions always require your approval first. It doesn't describe what you _could_ do. It does it.

**It remembers you.** Not just within a single conversation. Across days, weeks, months. Your preferences, your projects, your quirks. It builds a picture of who you are and uses that to help you better over time.

**It has its own identity.** Your assistant isn't borrowing yours. It can have its own email, its own GitHub account, its own Slack handle. When it sends an email on your behalf, the recipient knows they're talking to your assistant, not to you. Clear boundaries, no confusion.

**Your data stays yours.** Your workspace, your memories, your configuration... all live in your private Cadet Cloud account, encrypted and isolated, or on your own machine if you self-host. No shared database, no opaque storage, no data you can't access. Plain-text, exportable, deletable, yours.

**It's personal.** Not a team tool. Not a shared resource. Not a Slack bot everyone in your company uses. It's _your_ assistant, personalized to _you_, and nobody else can access it.

Tools like OpenClaw and Hermes Agent take a more DIY approach. They run in your terminal, expect you to configure them yourself, and assume you're comfortable wiring up API keys, model providers, and tool integrations before you can get anything done.

**It works out of the box.** No config files to write, no CLI to install, no model routing to set up. Sign up and your assistant is running, connected to cloud AI models, and ready to go. OpenClaw and Hermes expect you to bring your own keys, pick your own providers, and handle the plumbing yourself.

**It has a real interface.** A polished web app and desktop apps for macOS and Windows. You can see your memories, browse your skills, manage integrations, and read conversation history in a UI designed for humans. OpenClaw and Hermes live in the terminal, which works if you're a developer who lives there too, but most people want a screen they can click.

**It's built for security and reliability.** Credentials are encrypted at rest. Sensitive actions require explicit approval. Your workspace is isolated to your account with no shared state. Cadet Cloud runs on managed infrastructure with monitoring and uptime you don't have to maintain. Self-hosting is there if you want full control, but you don't have to trade reliability for ownership.

OpenClaw and Hermes are powerful if you're technical and want to build everything yourself. Cadet is for people who want the power without the setup tax.

### What can it do?

A non-exhaustive list of things your assistant can handle, organized by category:

#### 💬 Communication

- **Gmail** — Manage your inbox, draft replies, archive, label, and unsubscribe
- **Email (Agent Mail)** — Give your assistant its own email address to send and receive mail
- **Messaging** — Read, search, and send messages across multiple platforms
- **Phone Calls** — Make and receive phone calls via Twilio
- **Slack** — Scan channels, summarize threads, send and manage messages
- **Contacts** — Manage contacts, communication channels, and access control
- **Notifications** — Send notifications through the unified notification router

#### 📅 Productivity

- **Google Calendar** — Check schedules, create events, and coordinate availability
- **Tasks** — Reusable task templates and a prioritized work queue
- **Schedule** — Recurring and one-shot scheduling with cron, RRULE, or single fire-at time
- **Followups** — Track sent messages awaiting responses across channels
- **Playbooks** — Trigger-action automation rules for handling incoming messages
- **Document** — Write and edit long-form content like blog posts, articles, and reports
- **Start the Day** — Get a personalized daily briefing with weather, calendar, news, and tasks

#### 🖥️ Automation & Control

- **Computer Use**: Control your Mac or Windows PC: click, type, and navigate supported apps
- **Browser** — Navigate and interact with web pages using a headless browser
- **Screen Watch** — Observe the screen at regular intervals with OCR
- **Watcher** — Poll and monitor external sources for changes
- **Subagent** — Spawn autonomous background agents for parallel work

#### 🛠️ Development

- **App Builder** — Build interactive apps, dashboards, tools, and data visualizations
- **Frontend Design** — Create distinctive, production-grade frontend interfaces with high design quality
- **ACP** — Delegate coding tasks to external coding agents via the Agent Client Protocol

#### 🎨 Media

- **Image Studio** — Generate and edit images using AI
- **Media Processing** — Ingest and process video, audio, and image files
- **Transcribe** — Turn audio and video into text with Whisper

#### 🛍️ Services

- **Amazon** — Shop on Amazon and Amazon Fresh
- **DoorDash** — Order food, groceries, and convenience items
- **Weather** — Get current conditions and forecasts for any location

#### 🧠 Knowledge & Identity

- **Memory** — Remembers your preferences, projects, and context across conversations
- **SOUL.md / IDENTITY.md / USER.md** — Editable files that shape your assistant's personality and knowledge of you
- **Skill Management** — Create and manage custom skills as your needs evolve

#### 🔗 Integrations

- **OAuth Integrations** — Connect to third-party services like GitHub, Notion, Linear, Airtable, Spotify, and more
- **MCP Servers** — Add Model Context Protocol servers for extended tool access
- **ChatGPT Import** — Import conversation history from ChatGPT
- **Voice Input** — Hold Fn to talk to your assistant

And if it can't do something? You can teach it. Skills are modular and extensible — see [Your first skill](#your-first-skill) below.

### Where does it run?

Your assistant lives in Cadet Cloud by default and is reachable from anywhere. You can also self-host it on your own Mac if you want full control of the runtime.

**☁️ Cadet Cloud (default)**

Sign up and your assistant is provisioned in seconds, hosted in Cadet's secure cloud, always on, always reachable. No install, no servers to manage. Your workspace is encrypted and isolated to your account.

- Use it instantly in your browser at mycadet.ai
- Always-on availability, even when your laptop is closed
- Encrypted, isolated workspace tied to your account
- One assistant, reachable across web, desktop, mobile, voice, and chat channels

**🌐 Web app**

Open your assistant in any modern browser. Same conversation, memories, and tools as the desktop app, no install required.

- Works in Chrome, Safari, Firefox, Arc, and the rest
- Same workspace and identity as your desktop and mobile sessions
- Browser extension available for reading open tabs and acting on the page you're looking at

**🖥️ Desktop apps for macOS and Windows**

A menu bar app on macOS and a system tray app on Windows. Same assistant as the web app, plus computer control and voice input. See [Installation](#installation) for system requirements and setup.

- macOS DMG or Windows EXE installer
- Desktop automation through macOS accessibility APIs or Windows UI Automation
- Voice input with platform-specific shortcuts
- Connects to your Cadet Cloud assistant, or run a fully self-hosted local workspace

**📱 iOS app**

Install Cadet on your iPhone or iPad and sign in to the same assistant you use on the web and Mac. Your conversations, memories, tools, and workspace stay with you across devices.

- Available from the App Store
- Talk to your assistant from your iPhone or iPad
- Review approval requests from mobile notifications

**📡 Channels**

Beyond the apps, you can reach your assistant through external channels, so it's available wherever you are.

- **Telegram** — Chat with your assistant from any device via a Telegram bot
- **Slack** — Message your assistant directly in Slack, useful for work contexts
- **Phone** — Call your assistant or have it take calls on your behalf via Twilio

### How does it work? (The 30-second version)

1. **You talk to it.** In your browser, the desktop app, by voice, or through chat channels like Telegram, Slack, and phone.
2. **It thinks.** Your message, along with relevant context (your preferences, memories, workspace files), is sent to a cloud AI model to generate a response.
3. **It acts.** If the response involves doing something (reading a file, sending an email, building an app, or controlling your desktop), your assistant uses its tools to make it happen. For desktop actions, it sees your screen, plans the steps, and executes them automatically. But it won't go rogue — your assistant always asks for permission before taking sensitive actions like sending emails, making purchases, or accessing new services. You stay in control, and you can configure exactly what requires approval and what your assistant can handle on its own.
4. **It learns.** Important facts, preferences, and context are saved to your workspace so it gets better over time.

> **Transparency moment:** Whether your assistant lives in Cadet Cloud or on your own machine, it _thinks_ by talking to an AI model provider (like Anthropic). Your prompts and context are sent there to generate responses. This is the trade-off of a smart assistant. We'd rather tell you upfront than have you discover it in a footnote.

### Is it safe?

Cadet has a built-in trust system. Sensitive actions like sending emails, making purchases, or controlling your desktop require your explicit approval. You can configure trust rules per channel. Credentials are encrypted at rest in Cadet Cloud, or stored in the macOS Keychain when you self-host, never in plain text.

Learn more in [Trust & Security](/docs/trust-security).

## Installation

### What you need

- **For the web app:** any modern browser on Mac, Windows, Linux, or a phone. No install, no setup. The fastest way in. Connects to a cloud assistant.
- **For the iOS app:** an iPhone or iPad and your Cadet account. Connects to your cloud assistant.
- **For the Android app:** Android 7.0 or later and your Cadet account. Connects to your cloud assistant.
- **For the Mac app:** macOS 15 (Sequoia) or later, Apple Silicon or Intel, plus ~500 MB free disk space. Connects to a cloud or local assistant.
- **For the Windows app:** Windows 10 or later. Choose the x64 installer for Intel or AMD PCs, or ARM64 for Windows on Arm. Connects to a cloud or local assistant.
- There is no shipped Linux desktop client.
- Internet connection (your assistant uses cloud AI models to think)
- About 5 minutes and a willingness to talk to your computer

[Sign up](https://www.mycadet.ai/account/signup) and your assistant is provisioned in seconds.

### Web

The fastest way to meet your assistant. No install, no setup wizard, no config files. Your assistant runs in Cadet Cloud and you reach it from your browser.

1. Go to [mycadet.ai/signup](https://www.mycadet.ai/account/signup) and create your account.
2. Set your privacy preferences and accept the Terms of Service.
3. Watch your assistant hatch in the browser. About 30 seconds.
4. Say hi.

Your assistant lives in Cadet Cloud, encrypted and isolated to your account, reachable from any browser. You can also connect the desktop app, mobile app, voice, and chat channels (Telegram, Slack, phone) to the same assistant.

### iOS app

Install Cadet on your iPhone or iPad to use the same assistant, conversations, memories, tools, and workspace you have on the web and Mac.

1. Install Cadet from the [App Store](https://apps.apple.com/us/app/mycadet/id6759934423).
2. Open the app and sign in with your Cadet account.
3. Your cloud assistant appears automatically. Say hi.

Approval requests can arrive as mobile notifications, so you can review sensitive actions from your phone.

### Android app

Install Cadet on your Android phone or tablet to use the same assistant, conversations, memories, tools, and workspace you have on the web and Mac.

1. Install Cadet from [Google Play](https://play.google.com/store/apps/details?id=ai.mycadet.android).
2. Open the app and sign in with your Cadet account.
3. Your cloud assistant appears automatically. Say hi.

The Android app is a client for your cloud assistant. It does not run a local assistant on the phone. See [Downloads](https://www.mycadet.ai/downloads).

### Desktop app (macOS and Windows)

The desktop app is available on macOS and Windows, with a menu bar or system tray presence, voice input, and computer control. It connects to a cloud assistant by default (so your conversations and memory show up in both the web and desktop apps), but it can also run a local assistant entirely on your machine. See [Hosting options](/docs/hosting-options) for the local-only setup.

The Windows download is currently a **dev build**. It connects to Cadet's development environment, so your production cloud assistant and its history will not appear there. The main download is x64; select Other downloads for ARM64.

1. [Sign up](https://www.mycadet.ai/account/signup) for Cadet if you haven't already.
2. Download the macOS `.dmg` or Windows `.exe` from [mycadet.ai/downloads](https://www.mycadet.ai/downloads).
3. On macOS, open the `.dmg`, drag Cadet to Applications, and launch it. On Windows, run the `.exe` installer and open Cadet from Start.
4. Sign in with your Cadet account. Production builds connect to your existing cloud assistant; the Windows dev build connects to the development environment.

The installers include everything needed to run the app. macOS downloads are signed and notarized; Windows downloads are Authenticode-signed. No terminal setup is needed. On Windows, the app also installs the `cadet` CLI for your user account. Open a new terminal after the first launch to use it. The same page also offers the [Chrome extension](https://chromewebstore.google.com/detail/mycadet-browser/hphbdmpffeigpcdjkckleobjmhhokpne) for browser automation.

### Linux

There is no shipped Linux desktop client. A Linux desktop shell is in development and is not distributed.

On a Linux computer you can:

- Use the web app in any modern browser after you [sign up](https://www.mycadet.ai/account/signup).
- Install the [Chrome extension](https://chromewebstore.google.com/detail/mycadet-browser/hphbdmpffeigpcdjkckleobjmhhokpne) so the assistant can drive a logged-in Chrome session on that computer.
- Self-host the assistant runtime on that machine. That is the server, not a desktop app. See [Hosting options](/docs/hosting-options).

Do not wait for a Linux desktop installer, and do not treat a self-hosted Linux runtime as a replacement for the Mac or Windows desktop app's computer-use features.

### Self-hosting

Want to run Cadet entirely on your own machine or your own infrastructure? You can. The runtime is open source and supports local-only mode (workspace at `$CADET_WORKSPACE_DIR`) as well as remote deployment to your own GCP project or any Linux host.

Head to [Hosting options](/docs/hosting-options) for the full guide on local hosting and advanced deployment.

### Two ways to connect

- **Sign in with Cadet (default)** — Authenticate with your Cadet account for the cloud experience. Your assistant runs in Cadet Cloud, billing is handled through your account, no API keys to manage.
- **Bring your own API key** — Self-host the runtime and connect it to your own Anthropic API key. Useful if you want to run everything on your own machine. Cadet manages your credentials separately from the assistant.

### What gets installed

If you run the desktop app or self-host, Cadet creates one directory on your machine. (Cadet Cloud users don't need to think about this. Your workspace lives in your encrypted cloud account and is available through the web app.)

```
~/.cadet/
├── workspace/
│   ├── IDENTITY.md        # Name, personality, emoji
│   ├── SOUL.md            # Principles and behavior rules
│   ├── USER.md            # What the assistant knows about you
│   ├── NOW.md             # Current focus, goals, and context
│   ├── config.json        # Runtime configuration
│   ├── skills/            # Installed and custom skills
│   └── data/
│       └── db/
│           └── assistant.db   # Conversations, memory, schedules (SQLite)
├── lockfile.json          # Running assistant instances and ports
```

Everything is plain text (aside from the SQLite database). You can open these files in any editor, read them, change them, even put them in version control. Your assistant's brain is not a black box. It's a folder on your computer.

Session logs are stored in `~/Library/Application Support/mycadet/logs/`. The daemon binary lives inside the `.app` bundle, not in `~/.cadet/`.

### Permissions

Cadet doesn't ask for all its permissions upfront. Instead, permissions are requested only when they're actually needed:

| Permission         | Purpose                                  | When requested                                             |
| ------------------ | ---------------------------------------- | ---------------------------------------------------------- |
| Screen Recording   | See your screen for computer-use tasks   | First time your assistant needs to see your screen         |
| Microphone         | Voice input (hold Fn to talk)            | First time you use voice input                             |
| Speech Recognition | Convert voice to text                    | First time you use voice input                             |
| Accessibility      | Control your Mac (click, type, navigate) | First time your assistant needs to interact with your apps |
| Notifications      | Status updates and reminders             | Optional, on first notification                            |

On Windows, open Settings > Permissions & Privacy in Cadet to check microphone, screen capture, speech, and notification access. Use the settings link beside a permission to open the corresponding Windows settings page. Accessibility, Input Monitoring, and Automation permissions are macOS-only and do not appear on Windows. Computer control cannot interact with elevated or protected windows.

> **Worth knowing:** The app accesses files through normal sandbox entitlements, not Full Disk Access. Individual file and shell actions still require your approval through the in-app permission system. Check out [Trust & Security](/docs/trust-security) for the full picture.

### Updates

Cadet checks for updates automatically in the background. When an update is available, you'll see a green update button in the top right corner of the app. You can install immediately or defer until later. Updates are signed and verified before installation.

### Definitions

Key terms and concepts used throughout the Cadet ecosystem.

- **[Assistant](#what-is-cadet)** — An AI-powered agent configured to perform tasks on your behalf. Each assistant is backed by a large language model and can be customized with specific instructions, skills, and channels.
- **[Channel](/docs/key-concepts/channels)** — The surface through which users interact with the assistant. Channels include the desktop app, command-line tool, and other application integrations like Telegram.
- **[Environment](/docs/hosting-options)** — The runtime context in which an assistant operates.
- **Guardian** — The user who is in charge of the assistant. The guardian oversees the assistant's behavior, manages its configuration, and ensures it operates within defined boundaries.
- **Hatch** — The process of creating and initializing a new assistant. When you hatch an assistant, it is configured and made ready to receive messages.
- **Retire** — The process of deactivating an assistant. Retiring an assistant stops it from receiving new messages and frees up associated resources.
- **[Skill](/docs/key-concepts/skills-and-tools)** — An action or capability that the assistant can invoke during a conversation. Skills allow the assistant to interact with external systems, run code, search the web, and more.

## Quick Start

You've installed Cadet. Now what? This section walks through how to actually start using your assistant after the install completes, whether you signed up for Cadet Cloud or set up a local install on your Mac.

### Your assistant is ready

When the install finishes, your assistant is provisioned and waiting. It's a blank slate. No name, no memories, no preferences, nothing yet. The more you work together, the more context it builds and the more useful it becomes.

There's no onboarding wizard. Just a chat box. Type something, ask a question, give it a task. That's how it learns about you.

### Where to talk to it

On Cadet Cloud, your assistant is the same wherever you sign in, with the same memory and the same conversation history carried across:

- **Web**: open [mycadet.ai](https://mycadet.ai) in any browser. No install needed.
- **iPhone or iPad**: install the Cadet app from the [App Store](https://apps.apple.com/us/app/mycadet/id6759934423) and sign in.
- **Android**: install the app from [Google Play](https://play.google.com/store/apps/details?id=ai.mycadet.android) and sign in.
- **Mac**: install the [desktop app](https://www.mycadet.ai/downloads). Same assistant, with the added ability to read your local files and control your Mac when you ask it to.
- **Windows**: install the [desktop app](https://www.mycadet.ai/downloads), or use the [Chrome extension](https://chromewebstore.google.com/detail/mycadet-browser/hphbdmpffeigpcdjkckleobjmhhokpne).
- **Linux**: use the web app, or the [Chrome extension](https://chromewebstore.google.com/detail/mycadet-browser/hphbdmpffeigpcdjkckleobjmhhokpne). There is no shipped Linux desktop client.

On a local install, your assistant lives on your Mac through the desktop app. Beyond that, you can hook up Telegram, Slack, email, and phone calls so your assistant can reach you outside of those first-party surfaces. See [Channels](/docs/key-concepts/channels) for the full set.

### What to say first

There's no wrong answer. A few good first moves:

- **Give it a name.** "Your name is Bob." That name will stick.
- **Tell it about yourself.** "I'm Alice. I work in marketing, live in Brooklyn, and prefer short, direct answers." That's the kind of context it folds into how it talks to you.
- **Ask what it can do.** "What are you good at?" or "What tools do you have?" It'll walk you through its current capabilities.
- **Shape its style.** "Be more casual, less corporate. Don't hedge." Style notes persist across conversations.

None of this is required. You can also just dive into a real task and let it pick up your context as it goes.

### Give it a real task

The best way to see what your assistant can do is to give it something you actually need. Some examples:

- "Draft a follow-up email to Alice about the launch meeting we had this morning."
- "Help me think through whether to take the new role."
- "Summarize what's on my calendar this week."
- "Build me a simple expense tracker I can use in the browser."
- "Remind me at 4pm to drink water."

If a task needs a tool your assistant doesn't have set up yet (your calendar, your email, etc.), it'll tell you what it needs and walk you through connecting it.

### Approvals

The first time your assistant tries to do something that could matter (sending an email, saving a file, scheduling something on your calendar), it'll stop and ask you first. You see exactly what it wants to do and you click Allow or Deny.

If you're using voice, it asks the same question out loud and you say yes or no. On iPhone, the prompt comes through as a notification you can tap.

You can also set up trust rules so it stops asking about things you've already approved. For the full picture, see [The permissions model](/docs/trust-security/the-permissions-model).

### What it remembers

Anything you tell it, anything it figures out about you, anything that comes up in conversation that's likely to matter later, it stores as a memory. Memories surface in future conversations when they're relevant, so you don't have to repeat yourself.

You can ask "What do you remember about me?" anytime. You can also tell it to forget something: "Forget what I told you about that project." See [Memory & Context](/docs/key-concepts/memory-and-context) for how it works.

### Connect more places

Your assistant can also reach you outside of the apps. Most people set up at least one of these in their first week:

- **Telegram**: chat with your assistant from any device that has Telegram installed.
- **Slack**: put your assistant in a Slack DM or workspace.
- **Phone calls**: your assistant gets a real phone number you can call.
- **Email**: your assistant gets its own email address it can send and receive on.

Setup is a few minutes per channel and runs through a verification handshake so only you can claim the connection. See [Channels](/docs/key-concepts/channels).

### Where to go next

- [Key Concepts](/docs/key-concepts): the workspace, memory, channels, tools, scheduling. The mental model behind how your assistant works.
- [Your first skill](#your-first-skill): how to add a new capability, like a new integration or a custom workflow.
- [Security best practices](/docs/trust-security/security-best-practices): the practical guide to staying safe while giving your assistant useful access.
- [FAQ](/docs/help/faq): answers to the questions most people have in their first week.

## Your first skill

Skills are how your agent learns to do new things. Not prompts you type once and forget, but durable capabilities you teach your agent once, and it keeps doing them for you.

The model matters, but it was never the thing holding you back. A raw agent does not know your work, your voice, your tools, or the way you like things done. Skills close that gap. Your agent comes with 40+ built-in skills, and you can teach it new ones just by talking to it.

### Why skills matter

Most people use AI as a chat. Ask something, get an answer, move on. The next day they ask the same thing and the agent starts from zero. That is not a problem with the model. It is a problem with the architecture.

A skill is the opposite of a one-off chat. It is a workflow you teach your agent once, and it runs the same way every time, with your format, your voice, your tools, and your edge cases locked in.

### What's a skill?

A skill gives your agent a new ability. It is a folder with a recipe, reference files, and tool declarations that teach your agent how to do one specific job well.

- The **Weather** skill checks forecasts for any location
- The **Gmail** skill reads, writes, and manages your email
- The **DoorDash** skill orders food, delivered to your door
- The **Schedule** skill sets up recurring tasks and reminders

You do not have to think about skills at all. Your agent picks the right one when you ask it to do something. But knowing they exist, and that you can build your own, changes what is possible.

### Built-in skills

Your agent ships with 40+ skills across communication, productivity, automation, development, and media. Most work instantly. A few, like Gmail, Slack, and Phone Calls, need a one-time setup, and your agent walks you through it on first use.

For the full list, see the [Skills Reference](https://www.mycadet.ai/skills).

### Installing community skills

Want something that is not built in? There is a growing library of community skills at [skills.sh](https://skills.sh). Just ask:

> "Search for a Notion skill."

Your agent finds it, shows you what it does, and installs it with your permission. From there it works just like a built-in skill.

### Building a custom skill

This is where it gets powerful. You can create new skills by describing what you want in the chat. Do not treat it as a feature request. Treat it as teaching. You are writing a recipe your agent will follow every time.

#### Step 1: Pick one task

Pick something you do every week and find tedious. Specific, not generic. Not "write blog posts." Something like:

> "Check our competitor pricing every Monday and give me a table with price, change, and verdict."

> "Read our overnight support tickets, group them by category, and post a summary to Slack at 9 AM."

The narrower the better. A skill that does one thing well beats a skill that tries to do everything.

#### Step 2: Draft the recipe

Your agent drafts the skill from what you described. It writes the instructions, bundles any reference notes and scripts the workflow needs, and sets the format. It does this with its built-in **Skill Management** skill, the skill that builds skills. You do not invoke it directly. Just describe what you want and your agent reaches for it automatically.

A good skill has four ingredients:

1. **Clear purpose.** One task, one output.
2. **Workflow steps.** The exact sequence your agent follows every time.
3. **Tool access.** What it needs to read, search, or call.
4. **Output format.** What a perfect result looks like. Show an example.

Your agent asks follow-up questions if it needs more detail. Be specific about format, voice, and edge cases. The recipe is only as good as the instructions.

#### Step 3: Test and iterate

Once the skill is saved, run it and look at the output. The first run is almost never perfect, and that is expected. Tell your agent what is off and have it fix it: a missing column, the wrong tone, a competitor you forgot to mention.

This is the teaching loop. Run it, judge it, fix it. Three rounds usually gets you to reliable, and the refinement is where the skill becomes yours.

#### Step 4: Refine until reliable

Your skill is saved as plain text files in `$CADET_WORKSPACE_DIR/skills/`. You can:

- Edit the files directly in any text editor
- Ask your agent to tweak it ("Make the verdict column bold")
- Add reference docs, like a brand voice guide or a glossary
- Add a schedule so it runs automatically
- Share it with other Cadet users

A reliable skill is one you trust enough to run without checking the output first. That is the payoff: it stops being work you do and becomes work your agent does for you.

---

For documentation on every built-in skill, see the [Skills Reference](https://www.mycadet.ai/skills). Or keep going to [Key Concepts](/docs/key-concepts) to understand how it all fits together.
