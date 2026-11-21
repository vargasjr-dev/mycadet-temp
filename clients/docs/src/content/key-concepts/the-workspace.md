Your assistant's identity, personality, and knowledge about you live in its workspace, a set of plain text files you can open, read, and edit.

On **Cadet Cloud**, your workspace is encrypted and isolated to your account. You browse and edit it through the web app. There's no folder on your computer to worry about.

On the **desktop app with local hosting**, the same workspace lives in a folder on your machine at `$CADET_WORKSPACE_DIR`, where you can also open it in any text editor. The structure and the files are the same in both places.

![The Workspace tab on the About your assistant screen, showing the file tree on the left and IDENTITY.md open in preview on the right](/docs/docs-workspace-files.webp)

## What's in there

Whether your workspace lives in Cadet Cloud or on your local machine, the structure is the same. The tree below shows the local layout; on Cloud, you see the same files in the web app.

```text
workspace/
├── IDENTITY.md            ← Who your assistant is
├── SOUL.md                ← How your assistant behaves
├── USER.md                ← What it knows about you
├── NOW.md                 ← Working scratchpad (tasks, context, goals)
├── config.json            ← Runtime configuration
├── conversations/         ← Per-conversation folders with attachments
├── skills/                ← Installed and custom skills
├── pkb/                   ← Knowledge base (notes about you and your work)
├── scratch/               ← Working files, exports, generated assets
└── data/                  ← Internal state
    ├── db/                ← Conversation history (SQLite)
    ├── qdrant/            ← Memory embeddings (vector DB)
    ├── apps/              ← User-built apps
    ├── avatar/            ← Avatar image
    └── logs/              ← Daemon logs
```

Credentials and secrets are kept in a separate, isolated store (the credential vault on Cloud, or `~/.cadet/protected/` on local). They're never included in workspace exports or diagnostic logs.

## The core files

Three identity files are loaded into every conversation. When your assistant wakes up, it reads them to remember who it is, who you are, and how it should behave. Edit any of them, and the changes take effect on the next conversation.

### IDENTITY.md

Your assistant's self-definition:

- **Name** — what you called it (or what it named itself during onboarding)
- **Emoji** — its signature emoji, chosen during onboarding
- **Nature** — how it thinks of itself
- **Personality** — a short description of its vibe and conversational style
- **Role** — what it does for you

```text
- Name: Gigi
- Emoji: 😏
- Nature: AI familiar
- Personality: Witty, sharp, slightly irreverent
- Role: Personal assistant, second brain
```

You can edit this file directly. Change the name, tweak the personality, swap the emoji. Your assistant picks up the changes next time you talk to it.

### SOUL.md

The big one. SOUL.md is your assistant's constitution — the principles and behavioral rules it follows in every conversation.

What's in here:

- **Core principles** — the fundamentals (be helpful, be resourceful, have opinions, earn trust)
- **Communication style** — how it talks to you (concise vs. detailed, casual vs. formal)
- **Task approach** — how it handles work (action over explanation, when to ask vs. just do)
- **Boundaries** — when to ask before acting, what lines not to cross

Your assistant updates this file on its own as it learns what works for you. But you can edit it too. Want it to stop being sarcastic? Remove the sarcasm. Want it to always explain before acting? Add that rule. It's your file.

### USER.md

Everything your assistant has learned about you:

- Your name and how you like to be addressed
- Your pronouns and locale
- Your work role and daily tools
- Projects you're working on
- Communication preferences
- Connected services and accounts

Your assistant adds to this over time through conversations. You can also edit it directly to fast-track the learning process or correct something it got wrong. If you declined to answer a question during onboarding, it's marked here so the assistant doesn't re-ask.

### NOW.md

A working scratchpad for what's happening right now. Unlike the identity files, NOW.md is ephemeral — it tracks in-progress tasks, session context, goals, and anything the assistant needs to carry between conversations.

The assistant reads and updates this file naturally as you work together. Think of it as a shared notepad — you can edit it too if you want to set priorities or leave context for the next session.

## Avatar

Your assistant has a visual identity too. There are two layers:

- **Character avatar** — the default. An SVG-based character composed from body shapes, eye styles, and colors, rendered as a PNG. This is what your assistant starts with.
- **Custom avatar** — you can set a custom image by uploading one, asking the assistant to generate one (it uses Gemini image generation), or dropping an image into the conversation. Custom images override the character avatar.

Removing a custom avatar restores the character avatar automatically. The image lives in `data/avatar/` and the assistant manages it through dedicated tools (`set_avatar`, `remove_avatar`, `get_avatar`) — you never need to touch files manually.

## Files you might see briefly

### BOOTSTRAP.md

This file only exists during onboarding. It's the script your assistant follows for your first conversation — figuring out its name, its vibe, who you are, and what you need help with. Once onboarding is complete, the assistant deletes it. If you see it in your workspace, onboarding hasn't finished yet.

### UPDATES.md

When your assistant gets an update, release notes appear in this file. The assistant reads them, decides what's worth telling you about, and then deletes the file. You might catch it between updates, but it's not meant to stick around.

## Conversations

Every conversation gets its own folder inside `conversations/`, named with a timestamp and unique ID. Each folder can contain attachments — files you sent to the assistant or that it generated during the conversation.

The workspace is version-controlled as a git repository on both Cloud and local. Your assistant automatically commits changes after each conversation turn, so you get a full history of how your workspace evolved over time.

## The skills/ directory

Custom skills you've built or installed from the community live here. Each skill gets its own folder. A minimal skill only needs one file:

- **SKILL.md** — instructions that teach the assistant when and how to use the skill

Community-installed skills can also include:

- **TOOLS.json** — a manifest of what tools the skill provides
- **tools/** — the implementation code behind those tools

Skills the assistant builds for you stay instruction-only: SKILL.md plus companion files like reference notes and scripts. They cannot register new tools.

Built-in skills from the catalog are loaded automatically and don't appear here — only custom and community-installed skills show up in this directory. You can inspect, modify, or delete any of them.

## Knowledge base

The `pkb/` directory is your assistant's personal knowledge base. It's a set of editable markdown files where your assistant keeps notes about you, your work, your projects, and anything else worth remembering across conversations.

Unlike memory embeddings (which the assistant queries semantically in `data/qdrant/`), the knowledge base is human-readable. Open `pkb/INDEX.md` to see what's in there, and edit any file directly to correct or add to what your assistant knows.

## Scratch space

The `scratch/` directory is a general-purpose working area. When the assistant generates images, exports files, writes scripts, or creates anything that isn't a conversation attachment, it lands here. Think of it as the assistant's desktop — a place for working files that don't belong anywhere specific.

## The data/ directory

This is where the assistant keeps its internal state. You generally won't need to touch these, but here's what's in there:

| Folder            | What it stores                                              |
| ----------------- | ----------------------------------------------------------- |
| `db/`             | Conversation history, messages, and tool invocations (SQLite) |
| `qdrant/`         | Memory embeddings powering the search system (vector DB)    |
| `apps/`           | Apps you've asked the assistant to build                    |
| `avatar/`         | Your assistant's avatar image                               |
| `logs/`           | Daemon logs (useful for debugging)                          |
| `browser-profile/`| Headless browser session data                               |
| `sounds/`         | Custom notification sounds                                  |

## Credentials and secrets

Credentials, API keys, OAuth tokens, and trust configuration are stored in a protected vault that lives outside the workspace. On Cloud, this is the cloud credential vault tied to your account. On local, it's a separate directory at `~/.cadet/protected/`.

Either way, secrets are never included in diagnostic exports or workspace backups. The assistant can use these credentials to take actions on your behalf, but cannot read or display them in conversation.

## The sandbox

On **Cadet Cloud**, your assistant runs in an isolated cloud sandbox. It can read and write files inside its own workspace, but has no access to a host machine, so the host tools and shell commands described below don't apply.

On the **desktop app**, your assistant operates within a stricter boundary because it can also reach into your local machine:

| Tool type       | Access                                                                        | Permission                   |
| --------------- | ----------------------------------------------------------------------------- | ---------------------------- |
| Workspace tools | `file_read`, `file_write`, `file_edit` — restricted to `$CADET_WORKSPACE_DIR`  | No approval needed           |
| Host tools      | `host_file_read`, `host_file_write`, `host_file_edit` — can access files anywhere on your machine | Requires approval |
| Shell commands  | `bash` runs in the workspace directory; `host_bash` runs on your machine       | `host_bash` requires approval |

Path traversal (using `../` to escape the workspace) is blocked. Symlinks that point outside the boundary are rejected. Workspace file access is enforced by the assistant itself; shell commands run in the workspace directory and are gated by risk classification and your approval settings. OS-level isolation applies when the assistant runs in a container (Docker or remote deployments).

## Why this matters

- **The parts that matter are readable.** Your assistant's identity, personality, and knowledge about you are plain text files. Open them, read them, know exactly what your assistant thinks it knows.
- **The parts that matter are editable.** Don't like the personality? Edit SOUL.md. Wrong fact about you? Fix USER.md. Changes take effect next conversation.
- **It's version-controlled.** The workspace is a git repository. Every conversation turn is committed automatically, so you can see exactly what changed and when.
- **It's yours.** Your workspace lives in your private Cadet Cloud account, or on your own machine if you self-host. Credentials are stored separately and excluded from any exports. We don't share your workspace with other users, and we don't read it.
