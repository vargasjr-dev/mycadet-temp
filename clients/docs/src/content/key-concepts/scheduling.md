Your assistant doesn't just respond when you talk to it. It can also work on its own, on a schedule you define. Scheduling lets you set up tasks that run automatically: once at a specific time, or repeatedly on a cadence.

Think of it as giving your assistant a calendar of its own. Instead of waiting for you to ask, it can check things, send things, and surface things proactively.

## Why scheduling matters

Most AI assistants are purely reactive. You ask, they answer. But a lot of useful work is repetitive and time-based: checking for updates, sending reminders, generating reports, following up on things that went quiet.

Scheduling turns your assistant from something you talk to into something that works for you in the background. It's the difference between a tool you pick up and an assistant that's actually assisting.

## Types of scheduled work

There are several flavors of automated work, each suited to different needs.

### One-shot schedules

A single task that fires at a specific time. You give it an ISO 8601 timestamp and a message. It fires once, then is automatically marked as `fired` and disabled. This is what used to be called "reminders" — now it's a unified concept.

- "Remind me to call the dentist tomorrow at 9am"
- "Send Alice a follow-up email on Friday if she hasn't replied"
- "Check the deployment status in 30 minutes and let me know"

### Recurring schedules

Tasks that repeat on a cadence. Under the hood, these use standard cron expressions (5-field) or RRULE recurrence rules (RFC 5545), but you don't need to know that — just describe what you want in plain language and the assistant translates it.

RRULE supports advanced patterns that cron can't: bounded recurrence (`COUNT=30` or `UNTIL=...`), set constructs with `RDATE` / `EXDATE` / `EXRULE` for adding or excluding specific dates, and union patterns with multiple `RRULE` lines.

- "Every morning at 8am, give me a summary of my calendar and unread emails"
- "Every Friday afternoon, compile a weekly status update from my Slack activity"
- "On the 1st of each month, remind me to review my subscriptions"
- "Every weekday except holidays" (daily minus specific EXDATE entries)

### Heartbeats

A heartbeat is a periodic background checklist. Your assistant runs through the items in `HEARTBEAT.md` at a configurable interval and only surfaces things when they need your attention. It runs in a separate background conversation, not your active chat.

Configuration lives in `config.json`:

- `heartbeat.enabled` — toggle on/off (requires restart)
- `heartbeat.intervalMs` — milliseconds between runs (default: 1 hour)
- `heartbeat.activeHoursStart` / `heartbeat.activeHoursEnd` — restrict runs to certain hours (0–23, both must be set together)

The default checklist focuses on your user relationship — reviewing the scratchpad, thinking about follow-ups from recent conversations, and reaching out when there's something worth sharing. You can customize `HEARTBEAT.md` to check whatever you want, and changes take effect on the next run without a restart.

### Watchers

Watchers are a polling-based monitoring system for external services. Instead of running on a fixed schedule with a message, a watcher polls a specific provider for new events and processes them with an action prompt you define.

Each watcher has:

- **Provider** — the external service to poll (Gmail, Outlook, GitHub, Google Calendar, Outlook Calendar, or Linear)
- **Action prompt** — LLM instructions for handling detected events
- **Poll interval** — how often to check (minimum 15 seconds, default 60 seconds)
- **Watermark** — tracks what's already been seen so events are never processed twice

- "Watch my Gmail for important emails and notify me immediately"
- "Monitor this GitHub repo for new issues assigned to me"
- "Watch my Google Calendar and alert me 10 minutes before meetings"
- "Track new Linear issues in the Engineering project"
- "Watch my Outlook inbox for messages from my manager"

### Playbooks

Playbooks are trigger-action automation rules — not time-based like schedules, but event-based. They tell your assistant how to handle incoming messages that match a pattern.

Each playbook has:

- **Trigger** — pattern or description that activates the rule
- **Action** — what to do when triggered (natural language)
- **Channel** — which channel it applies to (`*` for all, or a specific channel)
- **Autonomy level** — `auto` (execute immediately), `draft` (prepare for review), or `notify` (alert only)
- **Priority** — numeric priority for overlapping rules (higher wins)

- "When I get a meeting request, draft a polite decline"
- "When someone messages me on Slack with 'urgent', notify me on Telegram immediately"
- "When an email comes from my boss, auto-flag it as important"

### Subagents

Subagents are the on-demand cousin to scheduled work. Instead of running on a cadence or in response to an external event, they spin up immediately when your assistant needs to do something in parallel and report back later.

Each subagent runs in its own isolated context with its own role (research, coding, planning, etc.) and a specific task to complete. The parent assistant keeps chatting with you while the subagent works in the background. When it's done, results stream back so your assistant can use them.

- "Spawn a research subagent to dig into competitor pricing while we keep planning the launch"
- "Run three coding subagents in parallel, one per refactor target"
- "Kick off a planning subagent for the Q3 roadmap draft and bring it back when ready"

Schedules vs. subagents: **schedule** = "do this on a cadence", **subagent** = "do this in parallel right now and report back." They compose: a recurring schedule can spawn subagents to fan out work each time it fires. See [Subagent skill reference](/docs/skills-reference/subagent) for the full toolset.

## Schedule modes

Schedules (both one-shot and recurring) have four modes that control what happens when they fire:

- **Execute** (default) — sends the schedule's message to a background assistant conversation. The assistant processes it autonomously as if you had sent it. Use this for tasks that need the assistant to actually do something: "check my calendar and send me a digest."
- **Notify** — sends a notification to you via the notification pipeline. No assistant processing occurs. Use this for simple reminders: "remind me to take medicine at 9am."
- **Script** — runs a shell command on a cadence with no LLM in the loop. Stdout, stderr, and exit code are captured into the run record. Use this for cheap, deterministic background jobs (rotating logs, syncing a file, pinging an endpoint) where you don't need assistant reasoning.
- **Workflow** — runs a saved workflow when the schedule fires, optionally with arguments. Use this when the work is already captured as a multi-step workflow and you want it on a cadence instead of triggering it by hand.

Execute-mode schedules run with full access to skills and tools, so the assistant can check your email, query APIs, build reports, anything it can do in a normal conversation. Script and notify modes skip the LLM entirely and are correspondingly cheap.

There is also a wake behavior, which resumes an existing conversation with a hint instead of starting a new one. You don't pick it as a mode. It is what your assistant sets up when you ask it to come back to a thread later ("pick this up tomorrow morning and continue the research"), so the context you've already built is still there.

## Notification routing

When a schedule fires in notify mode, you can control where the notification goes:

- **All channels** (default) — deliver to every available channel
- **Single channel** — deliver to one specific channel ("remind me on Telegram")
- **Multi channel** — deliver to a subset of channels

You can also pass routing hints to influence delivery — for example, preferred channels or exclusions. Most of the time, the default (all channels) is what you want.

## Schedule lifecycle

Every schedule moves through a set of statuses:

- `active` — enabled and waiting for the next trigger time
- `firing` — currently executing
- `fired` — one-shot schedule that has completed (automatically disabled)
- `cancelled` — cancelled before it could fire

Recurring schedules stay `active` after each run and automatically compute the next trigger time. One-shot schedules transition to `fired` after completing.

Each run is recorded with its status, duration, output, and any errors. You can ask your assistant "show me my schedules" to see the full list with their statuses and recent run history.

## Use cases

A few ways scheduling and automation come together:

- **Morning briefing** — recurring schedule at 8am, execute mode. The assistant checks your calendar, email, and Slack, then sends you a digest.
- **Follow-up tracking** — one-shot schedule set 3 days out, execute mode. "If Alice hasn't replied by Thursday, draft a follow-up."
- **Inbox monitoring** — Gmail watcher with a 60s poll interval. "When an important email arrives, notify me on Telegram."
- **GitHub triage** — GitHub watcher monitoring a repo. "When a new issue is assigned to me, summarize it and add it to my task list."
- **Auto-responder** — playbook on the email channel. "When I get a meeting request, draft a polite decline with my availability link."
- **Simple reminders** — one-shot schedule, notify mode. "Remind me to call the vet at 3pm."
- **Relationship check-ins** — heartbeat running every hour during work hours. Reviews the scratchpad, checks for pending follow-ups, reaches out when there's something worth sharing.

## How scheduling connects to other concepts

- **Skills** — scheduled tasks can use any skill the assistant has access to. A morning briefing schedule can use Gmail, Google Calendar, and Slack skills in a single run. Watchers rely on connected integrations (Gmail, GitHub, etc.) for their providers.
- **Channels** — notify-mode schedules and watchers deliver through the notification pipeline, which routes to your connected channels. Playbooks can be scoped to specific channels.
- **Memory** — schedule and watcher execution happens in background conversations that have full access to the assistant's memory. The assistant remembers context from previous runs.
- **Tasks** — schedules can create, update, or check tasks. A recurring schedule might review your task queue and flag overdue items.

## What happens when you're away

Scheduled tasks run as long as the assistant process is running. On Cadet Cloud (the default), the assistant runs 24/7, so schedules, watchers, and heartbeats fire reliably regardless of whether your desktop is on. For self-hosted installs, the Cadet daemon on your machine needs to be active.

The scheduler ticks every 15 seconds, so schedules fire within that window of their target time.

If the assistant was offline when a schedule was supposed to fire, missed one-shot schedules will fire on the next startup. Recurring schedules compute their next run from the current time, so they don't replay missed runs — they just resume on cadence.

## Setting up a schedule

Just tell your assistant what you want in plain language:

- "Remind me to call Mom at 6pm"
- "Every Monday at 9am, check my email and summarize it"
- "Watch my GitHub for new issues assigned to me"
- "When I get an email from a recruiter, draft a polite pass"
- "Set up a heartbeat to check in every hour"

The assistant handles the translation to cron/RRULE expressions, watcher configurations, or playbook rules. You can also manage everything programmatically — schedules, watchers, and playbooks all have full CRUD tools (`schedule_create`, `watcher_create`, `playbook_create`, etc.) and can be listed, updated, or deleted.
