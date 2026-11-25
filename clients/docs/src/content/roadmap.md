This roadmap is the bridge between today's [architecture](/docs/architecture) and achieving the Cadet [Vision](/docs/vision).

## Release Migrate from Vellum Desktop Support

We already have a [Vellum to Cadet](https://github.com/vargasjr-dev/vellum-to-cadet) 
migration package that old Vellum Assistant users have been using to migrate their
assistants over to Cadet. To this point, it was confined to just technical users.
Building it into the Desktop app will allow anyone to migrate their Vellum assistants
over to Cadet.

## Launch the mobile apps

This will include both Cadet for iOS and Cadet for Android.

## Launch Cadet Cloud

A brand new platform for hosting Cadet assistants, rebuilt from the ground up to host
assistants as cheaply as possible, using predictable and simple pricing. Made for anyone
looking to spin up a Cadet assistant as quickly and as accessibly as possible, without the
maintenance burden of self hosting one.

## Extract Every integration as a plugin

Extract all of the bespoke integrations weighing down the assistant harness into
integration plugin, giving users both a cleaner Cadet to start with and making it
extremely simple to extend with any Agent Plugin on the market.

## Premiere Coding Agent

It's clear that the best agents are the best coding agents, as all future customization
becomes the assistant building it itself to serve the user. This initiative will analyze
all of the gaps separating Cadet from industry leaders like Claude Code, Codex, Muse, Hermes,
etc, and close the gap on all the core capabilities missing.

## Fully customizable interfaces

Users shouldn't have to settle for the interfaces that the Cadet Clients bring out of the box.
Their interfaces should be fully dynamic and adapt with the help from their Cadet. Every Cadet's
interface experience should look entirely unique.

## Interacting with other Cadets

Cadet already has the base primitives for managing contacts. This effort solves all of the outstanding
issues preventing simple interaction between a user and another user's Cadet.

## Schedules move out of the sandbox

Recurring tasks, wakes, and heartbeats move from the assistant container to
the gateway container to have reliable cadence of invoked jobs.


## The Agent loop moves out of the sandbox

The main agent loop and the model profiles that run it is moved into the gateway to ensure
higher reliability and uptime. This makes all operations surrounding model profile
configuration out of reach from the assistant itself and forced to go through the Guardian.
This aligns Cadet with the growing industry trend of designing agents with the harness
outside of the sandbox.

## Rebrand `assistant` to `sandbox`

Now that the `assistant` container no longer has the agent loop, it can be rebranded as the 
`sandbox` package, aligning with industry trends and opening up compatibility with the vast
ecosystem of sandbox providers developing.

## Rebrand `gateway` to `harness`

Rename and relabel everything related to gateway to harness, to align with industry trends.

## Rebrand `credential-executor` to `vault`

Rename and relabel everything related to credential-executor to vault. Is shorter, forces us to
make that package simpler, and allow us to support integration with other vaults like 1Password
or egress proxies from sandbox providers.

## Expose `@mycadet/admin`

The web module responsible for enabling management of multiple assistants on a single cloud host
like Cadet Cloud becomes open source, enabling capable operators in other communities and organizations
to self host their own fleet of Cadets.

## Cadet on the move

There's no reason why your Cadet should only help you with tasks in the digital world. We want to enable
the embedding and connection of Cadet to robotics so that it can help you in the real world.

## Cadet models that belong to YOU

No matter how much you edit your System Prompt, your skills, or any other context you have, the models
that power your Cadets were massively trained against data that will make it sound like Claude. It can
never be *yours* while this is the case. We want to research and enable Cadets who use models that not
only can be fine tuned easily on the guardian's own data, and can be hosted by only the guardian so 
data never reaches other Cadet guardians, but that can learn as the guardian interacts with them.

