# From today to the north star

Cadet's architecture is moving in one direction: everything your assistant
_judges_ with — its loop, its memory, its schedule, your keys — consolidates
into a hardened core, while everything it _experiments_ with — code, commands,
files — runs in a disposable workbench that holds nothing precious.

This page is the plan, one step at a time. Each step ships on its own and
makes the next one easier. Every entry here starts as today's architecture
(see [Today](/docs/architecture/today)) and lands at the [north
star](/docs/architecture/north-star).

## Schedules move out of the sandbox

Recurring tasks, wakes, and heartbeats move to a hardened scheduler that
keeps working when the sandbox sleeps, restarts, or crashes. The assistant
still writes its own schedule — the core just owns the clock, validates
every change, and keeps a floor no edit can delete.

## Keys move out of the sandbox

Long-lived credentials leave the assistant's workspace for good. Tools get
short-lived, scoped tokens issued per call through a credential broker, so
a prompt injection or a buggy plugin can never spend more than a single
permission slip.

## The loop moves out

The agent loop — the thing that thinks, plans, and decides — runs in the
hardened core. The sandbox becomes a pure workbench: it executes commands
and file operations and returns results, holding no loop, no credentials,
and no durable state. Judgement and experimentation live in separate
machines.

## Plugins keep their powers, not the keys

Plugins and hooks keep everything that makes them useful, but they influence
the assistant by handing back a structured patch that the core validates —
never by running inside it. Extending your assistant stops requiring
trusting an extension with the loop itself.

## Subagents and wakes become core objects

When a tool needs a helper or a timer, it stops doing it itself and asks the
core. Every subagent gets its own budget and scoped access; every wake is
held by a scheduler that cannot die. The core knows the whole family tree —
and every off switch.

## One core, one workbench

The gateway and the assistant merge into a single hardened service beside a
disposable workbench container. Fewer moving parts, a smaller trusted
surface, and an architecture where the worst thing that can happen inside
the workbench is losing the workbench.
