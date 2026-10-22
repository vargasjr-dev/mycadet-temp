/** Declarative help for the `assistant cloud` command. */

import type { CliCommandHelp } from "../../lib/cli-command-help.js";

export const cloudHelp: CliCommandHelp = {
  name: "cloud",
  description: "Manage Cadet Cloud integration",
  options: [
    { flags: "--json", description: "Machine-readable compact JSON output" },
  ],
  helpText: `
The cloud subsystem manages the connection to Cadet Cloud. Use
'connect', 'status', and 'disconnect' to manage cloud credentials.
Any assistant using the cloud LLM proxy can use these commands.

External service callbacks (Telegram webhooks, Twilio webhooks, email,
OAuth redirects) route through the cloud's gateway proxy via
'callback-routes'. Works for both cloud-managed and self-hosted
assistants.

Examples:
  $ assistant cloud status --json
  $ assistant cloud connect
  $ assistant cloud disconnect
  $ assistant cloud callback-routes register --path webhooks/telegram --type telegram --json`,
  subcommands: [
    {
      name: "connect",
      description:
        "Connect this assistant to Cadet Cloud by storing credentials",
      helpText: `
Initiates a cloud connection flow. Emits a signal for connected clients
to show a cloud login UI where the user can sign in and store credentials.

Use 'assistant cloud status' to check the current connection state and
'assistant cloud disconnect' to remove stored credentials.

Examples:
  $ assistant cloud connect
  $ assistant cloud connect --json`,
    },
    {
      name: "status",
      description:
        "Show current platform deployment context and connection status",
      helpText: `
Reads platform-related environment variables and stored credentials to report
the current platform deployment context and connection state.

Fields:
  isPlatform          Whether IS_CLOUD is set (boolean)
  baseUrl             CADET_CLOUD_URL — the cloud gateway base URL
  assistantId         This assistant's platform UUID
  hasAssistantApiKey  Whether a stored assistant API key is available; null
                      when the credential store could not be read
  hasWebhookSecret    Whether a stored webhook secret is available (needed
                      for email and other inbound webhook channels)
  available           Whether callback registration prerequisites are satisfied
  organizationId      The cloud organization ID (from stored credentials)
  userId              The cloud user ID (from stored credentials)

For the Tunnel state (only relevant for Twilio webhooks and live
voice/audio), use 'assistant gateway status' instead.

Examples:
  $ assistant cloud status
  $ assistant cloud status --json`,
    },
    {
      name: "disconnect",
      description: "Disconnect from Cadet Cloud by removing stored credentials",
      helpText: `
Removes all stored cloud credentials from the assistant's secure
credential store. After disconnecting, cloud-managed features (managed
proxy, cloud OAuth, callback routing) will no longer be available until
you reconnect with 'assistant cloud connect'.

Use 'assistant cloud status' to check the current connection state
before disconnecting.

Examples:
  $ assistant cloud disconnect
  $ assistant cloud disconnect --json`,
    },
    {
      name: "callback-routes",
      description: "Manage platform callback route registrations",
      helpText: `
Callback routes tell the cloud gateway how to forward inbound provider
webhooks to the correct assistant instance. Each route maps a callback path
and type to a stable external URL that external services (Telegram, Twilio,
email, OAuth providers) should use.

Examples:
  $ assistant cloud callback-routes list
  $ assistant cloud callback-routes list --json
  $ assistant cloud callback-routes register --path webhooks/telegram --type telegram --json
  $ assistant cloud callback-routes register --path webhooks/twilio/voice --type twilio_voice --json`,
      subcommands: [
        {
          name: "register",
          description: "Register a callback route with the cloud gateway",
          options: [
            {
              flags: "--path <path>",
              description:
                "Callback path (e.g. webhooks/telegram, webhooks/twilio/voice)",
              required: true,
            },
            {
              flags: "--type <type>",
              description:
                "Route type identifier (e.g. telegram, twilio_voice, twilio_status, oauth)",
              required: true,
            },
          ],
          helpText: `
Registers a callback route with the cloud's internal gateway endpoint so
the cloud knows how to forward inbound provider webhooks to this
cloud assistant instance.

Arguments:
  --path    The path portion after the ingress base URL. Leading/trailing
            slashes are stripped by the cloud.
  --type    The route type identifier used by the cloud to classify and
            route the callback.

Known callback path/type combinations:
  --path webhooks/telegram          --type telegram
  --path webhooks/twilio/voice      --type twilio_voice
  --path webhooks/twilio/status     --type twilio_status
  --path webhooks/resend            --type resend
  --path webhooks/mailgun           --type mailgun
  --path webhooks/email             --type email
  --path oauth/callback             --type oauth

Works for both cloud-managed and self-hosted assistants. Requires
CADET_CLOUD_URL and a cloud assistant ID. Returns the cloud-provided
stable callback URL that external services should use.

Examples:
  $ assistant cloud callback-routes register --path webhooks/telegram --type telegram --json
  $ assistant cloud callback-routes register --path webhooks/twilio/voice --type twilio_voice --json`,
        },
        {
          name: "list",
          description: "List registered callback routes for this assistant",
          helpText: `
Lists all callback routes registered with the cloud for this assistant.
Shows the route type, callback URL, and path for each registered webhook.

Requires cloud credentials (run 'assistant cloud connect' first or
ensure IS_CLOUD and CADET_CLOUD_URL are set and credentials are stored).

Examples:
  $ assistant cloud callback-routes list
  $ assistant cloud callback-routes list --json`,
        },
      ],
    },
  ],
};
