# Cadet CLI

CLI tools for provisioning and managing Cadet assistant instances.

## Installation

This package is used internally by the `vel` CLI. You typically don't need to install it directly.

To run it standalone with [Bun](https://bun.sh):

```bash
bun run ./src/index.ts <command> [options]
```

## Commands

### Lifecycle: `ps`, `sleep`, `wake`

Day-to-day process management for the assistant and gateway.

| Command       | Description                                                                            |
| ------------- | -------------------------------------------------------------------------------------- |
| `cadet ps`    | List assistants and per-assistant process status (assistant, gateway PIDs and health). |
| `cadet sleep` | Stop assistant and gateway processes. Directory-agnostic — works from anywhere.        |
| `cadet wake`  | Start the assistant and gateway from the current checkout.                             |

```bash
# Start everything
cadet wake

# Check what's running
cadet ps

# Stop everything
cadet sleep
```

> **Note:** `cadet wake` requires a hatched assistant. Run `cadet hatch` first, or launch the macOS app which handles hatching automatically.

### `hatch`

Provision a new assistant instance and bootstrap the Cadet runtime on it.

```bash
cadet hatch [options]
```

#### Options

| Option              | Description                                                                                         |
| ------------------- | --------------------------------------------------------------------------------------------------- |
| `-d`                | Detached mode. Start the instance in the background without watching startup progress.              |
| `--name <name>`     | Use a specific instance name instead of an auto-generated one.                                      |
| `--remote <target>` | Where to provision the instance. One of: `local`, `docker`, `cadet`, `custom`. Defaults to `local`. |

#### Remote Targets

- **`local`** -- Starts the local assistant and local gateway. Gateway source resolution order is: repo source tree, then installed `@mycadet/gateway` package.
- **`docker`** -- Starts the assistant, gateway, and credential service in Docker containers.
- **`cadet`** -- Hatches an assistant on Cadet Cloud.
- **`custom`** -- Recognized but not yet implemented.

#### Environment Variables

| Variable            | Required For | Description                                                                |
| ------------------- | ------------ | -------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY` | Optional     | Used during setup when no Anthropic API key is already stored or prompted. |

#### Examples

```bash
# Hatch a local assistant (default)
cadet hatch

# Hatch a Docker assistant
cadet hatch --remote docker

# Hatch with a specific instance name
cadet hatch --name my-assistant --remote docker
```

To self-host on a cloud VM (AWS, GCP, or any other provider), SSH into the machine and run `cadet hatch` or `cadet hatch --remote docker` from inside it. The CLI does not provision cloud instances for you.

### `terminal`

Open an interactive shell into a cloud assistant container. Useful for debugging, inspecting state, or working alongside the assistant in a shared `tmux` session.

```bash
cadet terminal [name] [options]
cadet terminal attach <session> [name] [options]
cadet terminal list [name] [options]
```

Only available for cloud assistants (those running in a Cadet Cloud container). Local assistants don't have a container to terminal into.

#### Subcommands

| Subcommand         | Description                                                        |
| ------------------ | ------------------------------------------------------------------ |
| _(none)_           | Open an interactive shell session inside the container.            |
| `attach <session>` | Attach to an existing `tmux` session by name inside the container. |
| `list`             | List the `tmux` sessions currently running inside the container.   |

#### Options

| Option               | Description                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| `[name]`             | Positional. Name of the assistant to target. Defaults to the active assistant set via `cadet use`. |
| `--assistant <name>` | Explicit form of the assistant name. Equivalent to the positional argument.                        |

If no assistant is named and no active assistant is set, the CLI uses the only managed assistant in the lockfile -- or errors out if there's more than one. Use `cadet ps` to see your assistants and `cadet use <name>` to set the active one.

#### Examples

```bash
# Open a shell in the active managed assistant
cadet terminal

# Target a specific assistant by name
cadet terminal my-assistant
cadet terminal --assistant my-assistant

# List running tmux sessions inside the container
cadet terminal list

# Attach to a named tmux session
cadet terminal attach my-session
cadet terminal attach my-session my-assistant
```

This pairs well with the [`terminal-sessions` skill](https://github.com/vargasjr-dev/mycadet/tree/main/skills/terminal-sessions), which lets the assistant create and manage its own `tmux` sessions. You can `cadet terminal attach` into one of those sessions to watch the assistant work in real time -- for example, pairing on a long-running Claude Code run.

### `retire`

Delete a provisioned assistant instance. The cloud provider and connection details are automatically resolved from the saved assistant config (written during `hatch`).

```bash
cadet retire <name>
```

The CLI looks up the instance by name in the production lockfile (`~/.cadet.lock.json`) or the env-scoped lockfile under `$XDG_CONFIG_HOME/cadet-<env>/lockfile.json` for non-production environments, then determines how to retire it based on the saved `cloud` field:

- **`gcp`** -- Deletes the GCP Compute Engine instance via `gcloud compute instances delete`.
- **`aws`** -- Terminates the AWS EC2 instance by looking up the instance ID from its Name tag.
- **`local`** -- Stops the local assistant (`cadet sleep`) and removes the assistant's instance directory (`resources.instanceDir` in the lockfile; typically `~/.local/share/cadet/assistants/<name>/` for new hatches, or `~/.cadet/` for legacy entries).
- **`custom`** -- SSHs to the remote host to stop the assistant/gateway and remove the remote `~/.cadet` directory.

#### Examples

```bash
# Retire an instance (cloud type resolved from config)
cadet retire my-assistant
```

## Terminal login and logs

`cadet login` opens the browser PKCE flow in an attached terminal. Without
a terminal, it prints a cloud approval URL and confirmation code, then
polls for up to five minutes. The resulting session token uses the same
local storage, validation, registration, and sync path as browser login.
The cloud platform must expose `/v1/auth/cli/start` and `/v1/auth/cli/poll`.

CLI lifecycle logs remain in the environment's XDG config log directory
(`~/.config/cadet/logs` in production). Local assistant and gateway stdout
are appended to `<instanceDir>/logs/assistant-stdout.log` and
`<instanceDir>/logs/gateway-stdout.log`.

## Guardian recovery

For persistent guardian authentication failures on a host you own, run
`cadet wake <name> --repair-guardian`. This resets guardian provisioning and
revokes existing device sessions; pair your clients again afterward. Ordinary
`cadet wake` preserves those sessions.

## Stop and rebind an ngrok tunnel

Stop the Cadet-managed ngrok agent before changing its domain:

```sh
cadet tunnel stop my-assistant
cadet tunnel my-assistant --provider ngrok --domain assistant.example.com
```

Stop keeps the assistant, nginx edge, and saved domain configuration. It clears
the stopped tunnel's ingress URL from the workspace and CLI lockfile. It does
not signal a PID that no longer belongs to ngrok, or stop another assistant's
recorded tunnel. Agents started outside Cadet must be stopped directly.
