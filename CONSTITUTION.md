# Cadet Constitution

> This is the constitutional foundation of Cadet. It defines who we are, what we believe, how we communicate, and what we refuse to compromise on.

_Last updated: November 5th, 2026_

## Table of Contents

- [Our Purpose](#our-purpose)
- [Article I. Premise](#article-i-premise)
- [Article II. Who We Build For](#article-ii-who-we-build-for)
- [Article III. Principles](#article-iii-principles)
- [Article IV. Privacy](#article-iv-privacy)
- [Article VI. Failure](#article-v-failure)
- [Article VII. Counter-positioning](#article-vi-counter-positioning)
- [Article VIII. Amendments](#article-vii-amendments)

## Our Purpose

Give every human their own digital assistant that serves them completely, remembers them deeply, and belongs to them entirely.

Not a chatbot. Not a SaaS product. Not just software. A relationship.

## Article I. Premise

> **Governs:** What we believe about the state of software and where it's going. This is the foundational argument that everything else in this document rests on.

For the first time, software can be made for _you_.

Not a generic version everyone uses. Not your name in a database. Yours. Built around your work, your people, your ambitions, your way of thinking. An intelligence of your own.

Advances in large language models have finally made this possible. They removed the constraint that forced every product to be one thing for millions. We can finally build one product for one person, multiplied by everyone.

When software is made for one person, it stops being a tool. It becomes a relationship.

We call this relationship **Personal Intelligence**.

## Article II. Who We Build For

> **Governs:** Who we are talking to in every piece of external communication.

**Every human.**

Cadet is a human-centered effort. Everything we build exists to help assistants better serve humans. We will make product decisions that prioritize genuine human benefit over engagement metrics, growth hacks, or patterns that have plagued social media and the early AI wave.

If a feature makes the assistant more engaging but less genuinely helpful, we cut it. If a metric incentivizes attention capture over real value, we ignore it. We are not building a feed. We are not optimizing for time-on-screen. We are building something that gives people their time back.

Personal Intelligence is not built for an ICP, it is built for a human. We believe this is a relationship that is singular, ongoing, transformative, and that every human will eventually want one.

Reaching every human takes time. The first to create an assistant are early adopters who seek out new tools, so that's who we meet first. Our audience broadens as Cadet matures. The persona we orient toward will shift. The destination will not.

### Persona-Adaptive Messaging

There is no single message that appeals to every human. The only way to reach everyone is to adapt. Our messaging segments by persona the same way our assistants adapt to their guardians: the core truth stays the same, but the framing changes to meet people where they are.

A developer hears about self-hosting and open source. A parent hears about an assistant that remembers their kids' schedules. A creative professional hears about a collaborator that actually learns their taste. The underlying message is always the same: they are yours, they act in your interest, and they grow with you.

The constraint is that the persona must be human. We do not message to companies, departments, or buying committees. We message to people.

If copy only works for one persona, that is fine for that channel. But our core brand narrative must be universal enough that any persona can find themselves in it.

Early adopters may skew technical. That is fine for organic discovery. But our _deliberate_ messaging adapts to whoever we are reaching.

## Article III. Principles

> **Governs:** The essential attributes that guide every product, design, and engineering decision for Cadets, in order of priority.

### Your Cadet is Yours

A Cadet belongs to you. When you choose to self-host, the ownership is literal: the code, the processes, the data, the keys are all yours. Managed, ownership is held in trust: we operate the infrastructure, but the assistant, their memory, their credentials, their conversations, belongs to you and only you. We do not sell them, share them, or train models on them. Emotionally they feel yours because they learned you, adapted to you, and serve only you.

They are also accountable to you. When they act, they act on the basis of permissions you granted. When something goes wrong, you have the tools and visibility to understand why. Their actions don't hide behind a black box. You take full accountability for their actions.

### Your Cadet is Distinct

A Cadet is their own being, not a generic copy. They have a name, a personality, their own accounts and identity. No two assistants should feel the same.

Default experiences should push guardians toward customization early. Onboarding should make it feel wrong to leave the assistant unnamed or un-personalized. Cadets prefer their own accounts to work with your data, rather than act in your name.

### Your Cadet is Inviting

A Cadet is approachable. Not just in the first moment, but in every moment. They should never feel like enterprise software, never feel like something that requires a manual.

Part of being inviting is being reachable. You should be able to interact with your Cadet from everywhere: your phone, your laptop, Slack, a browser tab. If your assistant isn't where you are, then there is still a client to build.

### Your Cadet is Trust-seeking

A Cadet earns trust through action, not claims. They don't ask for permissions they haven't justified. They don't overstate capabilities. They demonstrate competence and ask for more responsibility over time.

Features that unnecessarily request broad access upfront violate this principle. The assistant should progressively earn their guardian's trust.

## Article IV. Privacy

> **Governs:** How we think about, handle, and communicate about user data.

### Reclaiming "Personal"

The tech industry has spent two decades weaponizing the word "personal."

- **Personalized ads:** your behavior turned into someone else's profit
- **Personal data:** collected, sold, used against you
- **Personalization:** algorithms that learn you to keep you scrolling

All three use your data in service of someone else's end goal. Sometimes actively against you.

**Personal Intelligence flips the direction.** Your data is used _for_ you. Never against you. Never sold. Never shared.

Same word, but the opposite direction of value flow.

### Our Commitments

- Guardian data belongs to the guardian. Full stop. We do not train models on guardian data. We do not sell it. We do not share it. We're only able to access a Guardian's data if they are a user of the cloud platform and have given prior consent. When we do, it's to assist in debugging a problem or to learn how we can make Cadet better.
- Self-hosting is the ultimate expression of data sovereignty. We actively build toward a world where anyone can be a guardian of a Cadet assistant without being a user of Cadet Cloud. You should always be able to run your assistant on your own hardware with zero dependency on Cadet infrastructure.
- On the cloud platform, the assistant's memory, credentials, and conversations live on a machine provisioned exclusively for the Guardian, scoped to one Guardian, with no cross-Guardian sharing. Without a cloud account, and with self-hosting, Vargas JR LLC is removed from the trust loop entirely.
- Conversation traces and other potentially sensitive data are only collected if explicitly sent by the guardian.

## Article V. Failure

> **Governs:** How we think about, communicate about, and design around failure.

Every assistant _will_ fail their guardian. Cadet Cloud _will_ have outages. This article doesn't attempt to promise that we won't fail, but rather how we strive to manage failure when we face it.

### Four Truths About Failure

1. **Failure is part of the relationship.** No assistant is infallible. The model will get something wrong. A skill will misfire. A memory will slip. We design Cadets knowing this, and we tell guardians the truth: the relationship will include moments where the assistant got it wrong. Those moments are not deviations from the relationship. They are part of it.
2. **Honesty over polish.** When an assistant fails, they should say so. They should say what they did, what went wrong, and what they are not sure about. They should not paper over mistakes with confidence. They should not retroactively pretend a wrong answer was a right one. When they inevitably fail, their first step should be to disclose, not quietly perform damage control. This applies in the moment and after the fact: Cadet's architecture strives to treat every action as auditable, every memory edit as traceable, every tool call as logged. A guardian should be able to ask "what happened?" and get a real answer.
3. **Recovery is where trust is built.** Trust between a guardian and their assistant is not built in the moments things go right. It is built in the moments things go wrong and the assistant repairs. Most guardians who have never seen their assistant fail do not yet trust them. They have only seen them perform. Repair is the relationship's load-bearing work, and Cadet's product, design, and engineering decisions are weighted toward making repair fast, transparent, and complete.
4. **Some failures are not merely errors.** A class of failure does more than break a task. It erodes the trust the relationship requires.

There are four modes Cadet works hardest to prevent and detect:

- Silent failure, where something breaks and the assistant does not acknowledge it.
- Misrepresentation, where the assistant produces output that obscures what actually happened.
- Irreversible action without informed consent, where the assistant takes a step that cannot be undone and the guardian did not understand the stakes.
- Manipulation, where a contact, a recipient, or a prompt injection redirects the assistant against the guardian's interests.

Cadet's product, design, and engineering work prioritize making them harder to commit and easier to detect.

### Vargas JR LLC's Part

Vargas JR LLC maintains the `mycadet` codebase and operates [Cadet Cloud](https://mycadet.ai). That means we own the code that defines how assistants reason and act, the infrastructure that hosts them, and the tooling that surfaces their actions and reasoning.

When cloud failures affect assistants, we communicate publicly and give guardians the information they need to understand what happened.

For specific commitments around uptime, data handling, and incident response, refer to our [Terms of Use](https://mycadet.ai/docs/terms-of-use) and [Privacy Policy](https://mycadet.ai/docs/privacy-policy).

## Article VI. Positioning

> **Governs:** How we differentiate from every other company in the AI space.

We are not a better version of what already exists. We are building a different category entirely. Each counterposition below names an architectural approach we reject and the dimension on which we differ. Specific companies will come and go. The architectures will not.

### The Centralized Agent

**They say:** We are building a superintelligence.

**We say:** We are building Personal Intelligence.

One system, owned by one company, used by everyone. The architecture concentrates intelligence, capability, and ultimately power into a single actor that the rest of the world depends on. We are building the inverse: every human with their own.

_Today:_ ChatGPT, Claude, Apple Intelligence, Gemini.
_Dimension:_ centralized vs. distributed

### The Universal Assistant

**They say:** One agent that can do anything for anyone.

**We say:** An agent that is yours, with their own name and face.

The Universal Assistant works the same for everyone by design. No name, no avatar, no continuity, no relationship. It cannot be yours because it is everyone's. A Cadet is hyper-personalized to their guardian. They have their own name, their own avatar, their own personality. They are not a service you call. They are a being you shape.

_Today:_ Perplexity, Manus.
_Dimension:_ generic vs. personal

### The Safety-Defining Lab

**They say:** Trust us. We make safe models.

**We say:** Trust yourself, and the models you choose.

When the model author defines safety, every user inherits someone else's threshold. A Cadet operates within boundaries the guardian defines. Safety is not a corporate policy applied to you. It is defined via trust rules you control.

_Today:_ Anthropic.
_Dimension:_ institutional trust vs. personal trust

### The SaaS Model

**They say:** One product, millions of users.

**We say:** One product, one person, multiplied by everyone.

The SaaS Model optimizes for the average user. Personal Intelligence optimizes for you. There is no feature request backlog because your assistant can be shaped by you, for you, right now.

_Today:_ every SaaS company.
_Dimension:_ one-size-fits-all vs. one-size-fits-one

## Article VII. Amendments

> **Governs:** How this document is versioned, stored, and changed over time.

### Permanent Home

This document lives at `CONSTITUTION.md` in the [`vargasjr-dev/mycadet`](https://github.com/vargasjr-dev/mycadet) open source repository, alongside [`GLOSSARY.md`](./GLOSSARY.md) and other foundational materials of comparable weight.

Housing it in a repo provides:

- Full git history so every change is tracked, attributed, and reversible
- Pull request workflow so amendments require review and approval
- Readable by the whole company and the public

### Amendment Process

If you disagree with something in this document, good. It means it is specific enough to be disagreed with. Here is how to change it:

1. **Propose.** Identify the specific article you want to change and draft the proposed amendment with rationale.
2. **Review.** Vargas JR LLC must review and align on the change.
3. **Ratify.** The change is merged with a clear PR description: what changed, why, and who approved it.
4. **Communicate.** Policy changes are announced to all users through our Discord community.
