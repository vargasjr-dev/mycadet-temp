/**
 * IPC route definitions for the plugin email lane — the gateway-owned
 * email history the daemon's email tool lists and replies to over the
 * unix socket. The BYO/plugin lane's memory lives in the gateway; Cadet
 * Cloud Email's store is a different product.
 *
 * Failures throw IpcHandlerError so the daemon relay surfaces the HTTP-style
 * status (404 unknown row, 409 not replyable, 503 no credentials, 502 send
 * failed) as a RouteError the email tool can branch on.
 */

import { z } from "zod";

import { listEmailMessages } from "../db/email-message-store.js";
import { replyToPluginEmail } from "../email/plugin-email-surface.js";
import { IpcHandlerError } from "./assistant-client.js";
import { ipcRoute, type IpcRoute } from "./server.js";

const EmailListSchema = z.object({
  limit: z.number().int().positive().max(200).optional(),
});

const EmailReplySchema = z.object({
  /** The email_messages row id to thread onto. */
  reply_to: z.number().int().positive(),
  text: z.string().min(1),
});

export const emailRoutes: IpcRoute[] = [
  ipcRoute({
    method: "email_list",
    schema: EmailListSchema,
    handler: (params) => ({
      messages: listEmailMessages(params.limit ?? 50),
    }),
  }),
  ipcRoute({
    method: "email_reply",
    schema: EmailReplySchema,
    handler: async (params) => {
      const result = await replyToPluginEmail(params.reply_to, params.text);
      if (!result.ok) {
        throw new IpcHandlerError(result.error, result.status, "EMAIL_REPLY_FAILED");
      }
      return { message: result.message };
    },
  }),
];
