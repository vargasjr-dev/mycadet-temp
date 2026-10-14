import type { NavigateFunction } from "react-router";
import { assistantAuthHandoff } from "@app/domains/account/assistant-auth-handoff";
import {
  resolvePostAuthDestination,
  type PostAuthDestination,
} from "@app/domains/account/post-auth-destination";
import type { AuthCallbackIntent } from "@app/domains/account/provider-callback";
import { isLocalClient } from "@app/lib/runtime-mode";
import { routes } from "@app/utils/routes";

/** Refresh account and assistant facts before deciding where browser auth lands. */
export async function completeBrowserAuthentication(args: {
  refreshSession(): Promise<boolean>;
  authIntent: AuthCallbackIntent;
  returnTo: string | null;
  fallback: string;
  preferLocalAssistant?: boolean;
}): Promise<PostAuthDestination> {
  await args.refreshSession();
  await assistantAuthHandoff.refresh();
  if (args.preferLocalAssistant && isLocalClient()) {
    const hasAssistants = await assistantAuthHandoff.hasAssistants();
    if (hasAssistants && !args.returnTo) {
      return {
        destination: routes.assistant,
        requiresFullPageNavigation: false,
      };
    }
  }
  return resolvePostAuthDestination(args, assistantAuthHandoff.read());
}

export function navigatePostAuthDestination(
  result: PostAuthDestination,
  navigate: NavigateFunction,
  replace = false,
): void {
  if (result.requiresFullPageNavigation) {
    window.location.href = result.destination;
  } else {
    void navigate(result.destination, { replace });
  }
}
