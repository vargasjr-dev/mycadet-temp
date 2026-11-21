Control which LLM your assistant uses for each job — conversations, memory work, scheduled tasks — and override it per call-site when you need to.

## Overview

Model profiles control which AI model your assistant uses and how it behaves. You set one profile as the workspace-wide default, and your assistant applies it to everything — conversations, background memory work, scheduled tasks, and more. You can override it per conversation or per action type when you need different behavior.

## Built-in profiles

Every workspace starts with four built-in profiles. You can edit or duplicate them, but the defaults can't be deleted.

| Profile  | Model             | Best for                                                      |
| -------- | ----------------- | ------------------------------------------------------------- |
| Quality  | GPT-5.6 Sol       | Deep research, complex reasoning, high-stakes tasks           |
| Balanced | GPT-5.6 Luna      | Everyday use — capable across the board at reasonable cost    |
| Fast     | GPT-5.6 Luna      | Fast replies with reasoning off, for real-time surfaces like voice |
| Budget   | DeepSeek V4 Flash | Simple, short, or structural tasks run at high volume         |

**Balanced is active by default.** Every call your assistant makes — conversation replies, memory filing, title generation — runs with the Balanced profile unless you change it.

## Switching profiles

Open **Settings → Inference Profiles** and select a different active profile from the dropdown. The change applies workspace-wide immediately — no restart needed. You can also create custom profiles from this screen if you want to use a different provider or model not covered by the built-ins.

## Per-conversation override

Use the profile picker in the chat header to pin a different profile to a single conversation. It only affects that conversation — your workspace default stays untouched. This is the easiest way to run one session on a stronger or lighter model without changing anything globally.

## Our recommendation

Keep **Balanced** as your active profile — it covers everyday use well. Then use Action Overrides to selectively upgrade the actions that benefit most from a stronger model, and step down only for tasks where the output is purely structural.

A good rule of thumb: anything that shows up directly in your conversation or drives a decision should stay on at least Sonnet. Tasks like generating a title, formatting a notification, or suggesting conversation starters are good candidates for a lighter model — they're short, easy to verify, and quality differences are barely noticeable.

> **Tip:** use the per-conversation profile picker for one-off heavy tasks. Switch to Quality for a deep research session, then leave your workspace default untouched. That way you only pay for Opus when you explicitly reach for it.

## Action overrides

Open **Settings → Inference Profiles → Action Overrides** to assign a specific profile to individual actions. Each action has a toggle — when off it uses your active profile, when on you pick a profile just for that action. You can search by name and reset everything back to defaults at any time.

| Action                        | What it does                                                          | Recommended |
| ----------------------------- | --------------------------------------------------------------------- | ----------- |
| **Agent loop**                |                                                                       |             |
| Main agent                    | The primary conversation agent that handles your messages             | Quality     |
| Subagent spawn                | Spawns a subagent to handle a delegated subtask                       | Quality     |
| Heartbeat agent               | Runs background tasks and proactive checks on a schedule              | Balanced    |
| Filing agent                  | Files memories and updates the knowledge base after conversations     | Balanced    |
| Analyze conversation          | Analyzes conversation content for summaries and insights              | Balanced    |
| Call agent                    | Handles voice call conversations                                      | Quality     |
| **Memory**                    |                                                                       |             |
| Memory · Extraction           | Pulls facts and preferences out of conversations and stores them      | Balanced    |
| Memory · Consolidation        | Merges and deduplicates your memory store over time                   | Balanced    |
| Memory · Retrieval            | Searches memory to surface relevant context during conversations      | Balanced    |
| Narrative refinement          | Refines and polishes stored narrative memory entries                  | Balanced    |
| Pattern scan                  | Scans conversation history to detect behavioral patterns              | Balanced    |
| Conversation summarization    | Summarizes long conversation threads for memory and context           | Balanced    |
| Conversation starters         | Generates suggested openers for new conversations                     | Budget      |
| **Workspace**                 |                                                                       |             |
| Conversation title            | Generates a title for each conversation                               | Budget      |
| Commit message generator      | Writes git commit messages from staged changes                        | Balanced    |
| **UI**                        |                                                                       |             |
| Identity intro                | Generates your assistant's introductory message on first launch       | Balanced    |
| Empty-state greeting          | Generates the greeting shown on an empty conversation                 | Budget      |
| **Notifications**             |                                                                       |             |
| Notification decision         | Decides whether to surface a proactive notification to you            | Balanced    |
| Preference extraction         | Learns your communication preferences from how you interact           | Balanced    |
| **Voice**                     |                                                                       |             |
| Guardian question copy        | Generates spoken prompts during guardian verification flows           | Balanced    |
| Watch commentary              | Produces live commentary delivered via Apple Watch                    | Balanced    |
| Watch summary                 | Generates brief summaries surfaced on Apple Watch                     | Budget      |
| **Utility**                   |                                                                       |             |
| Interaction classifier        | Classifies the type of each inbound message to route it correctly     | Budget      |
| Style analyzer                | Analyzes your writing style to help your assistant match it           | Balanced    |
| Invite instruction generator  | Generates onboarding instructions for new assistant invites           | Balanced    |
| Skill category inference      | Automatically categorizes installed skills                            | Budget      |
| **Skills**                    |                                                                       |             |
| Meet · Consent monitor        | Monitors meeting consent during Google Meet sessions                  | Balanced    |
| Meet · Chat opportunity       | Identifies moments to send a helpful message during meetings          | Balanced    |
