import { readReturningUser } from "@app/assistant/returning-user";
import type { NativePostAuthContext } from "@app/runtime/native-post-auth-destination";

/** Assistant onboarding facts for native login. */
export const nativeAuthContext = {
  async read(): Promise<NativePostAuthContext> {
    return {
      returningUser: await readReturningUser(),
    };
  },
};
