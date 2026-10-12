# Plugins

Plugins extend the assistant's default capabilities using hooks, tools, skills, 
mcps, and more. Cadet's plugin spec is an extension of the evolving 
[Agent Plugins](https://agent-plugins.org/) standard evolving with personal assistant. 
It aims to be fully compliant with some additional functionality included to help each
Cadet truly customize themselves for their Guardians.

## Docs

The authoritative docs for how to develop, use, and share Cadet plugins can be found at https://mycadet.ai/docs/extensibility.

## Directory Structure

This repo is home to all of the default plugins that the Cadet team develops out of the box.
Each top level directory is its own plugin. Top level directories can extend existing
open source agent plugins repo to make them more compatible with Cadet until the changes
are merged upstream.
