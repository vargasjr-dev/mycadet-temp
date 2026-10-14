import { z } from "zod";
import { listAssistants } from "@web/assistant/api";
import { refreshCloudAssistantsIfStale } from "@web/assistant/cloud-assistants-sync";
import { nativeAuthContext } from "@app/runtime/native-auth-context";

const AssistantListSchema = z.array(z.object({ id: z.string().min(1) }));

/** Assistant facts and shared checkout storage for the composed account client. */
export const assistantAuthHandoff = {
  refresh: refreshCloudAssistantsIfStale,
  read: nativeAuthContext.read,
  async hasAssistants(): Promise<boolean> {
    try {
      const result = await listAssistants();
      if (!result.ok) {
        return false;
      }
      const parsed = AssistantListSchema.safeParse(result.data);
      return parsed.success && parsed.data.length > 0;
    } catch {
      return false;
    }
  },
};
