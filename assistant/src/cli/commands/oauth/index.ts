import type { Command } from "commander";

import { applyCommandHelp } from "../../lib/cli-command-help.js";
import { registerCommand } from "../../lib/register-command.js";
import { registerAppCommands } from "./apps.js";
import { registerConnectCommand } from "./connect.js";
import { registerDisconnectCommand } from "./disconnect.js";
import { oauthHelp } from "./index.help.js";
import { registerPingCommand } from "./ping.js";
import { registerProviderCommands } from "./providers.js";
import { registerProxyUrlCommand } from "./proxy-url.js";
import { registerRequestCommand } from "./request.js";
import { registerStatusCommand } from "./status.js";
import { registerTokenCommand } from "./token.js";

export function registerOAuthCommand(program: Command): void {
  registerCommand(program, {
    name: oauthHelp.name,
    transport: "ipc",
    description: oauthHelp.description,
    build: (oauth) => {
      applyCommandHelp(oauth, oauthHelp);

      // -----------------------------------------------------------------------
      // providers — subcommand group
      // -----------------------------------------------------------------------

      registerProviderCommands(oauth);

      // -----------------------------------------------------------------------
      // apps — subcommand group
      // -----------------------------------------------------------------------

      registerAppCommands(oauth);

      // -----------------------------------------------------------------------
      // connect — connect a provider via OAuth
      // -----------------------------------------------------------------------

      registerConnectCommand(oauth);

      // -----------------------------------------------------------------------
      // status — unified connection status
      // -----------------------------------------------------------------------

      registerStatusCommand(oauth);

      // -----------------------------------------------------------------------
      // ping — ping to see if a provider is connected and healthy
      // -----------------------------------------------------------------------

      registerPingCommand(oauth);

      // -----------------------------------------------------------------------
      // request — curl-like authenticated request command
      // -----------------------------------------------------------------------

      registerRequestCommand(oauth);

      // -----------------------------------------------------------------------
      // disconnect — disconnect a provider and remove its credentials
      // -----------------------------------------------------------------------

      registerDisconnectCommand(oauth);

      // -----------------------------------------------------------------------
      // token — retrieve a valid oauth token
      // -----------------------------------------------------------------------

      registerTokenCommand(oauth);

      // -----------------------------------------------------------------------
      // proxy-url: mint a passthrough-proxy grant for a third-party CLI
      // -----------------------------------------------------------------------

      registerProxyUrlCommand(oauth);
    },
  });
}
