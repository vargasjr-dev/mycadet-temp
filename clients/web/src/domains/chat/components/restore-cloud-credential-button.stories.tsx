import type { Meta, StoryObj } from "@storybook/react-vite";
import { type ReactNode, useLayoutEffect } from "react";

import { RestoreCloudCredentialButton } from "@/domains/chat/components/restore-cloud-credential-button";
import type { CloudSessionStatus } from "@/stores/session-status";
import { useAuthStore } from "@/stores/auth-store";

interface RestoreStoryArgs {
  /** Whether the client holds a cloud session; the repair needs one. */
  session: Extract<CloudSessionStatus, "present" | "absent">;
}

/**
 * The button reads the cloud session from the auth store, so each story
 * seeds it and puts the previous value back on unmount.
 */
function WithCloudSession({
  session,
  children,
}: {
  session: RestoreStoryArgs["session"];
  children: ReactNode;
}) {
  useLayoutEffect(() => {
    const previous = useAuthStore.getState().cloudSession;
    useAuthStore.setState({ cloudSession: session });
    return () => {
      useAuthStore.setState({ cloudSession: previous });
    };
  }, [session]);
  return <>{children}</>;
}

const meta: Meta<RestoreStoryArgs> = {
  title: "Chat/RestoreCloudCredentialButton",
  // Opted out of the global `autodocs` tag. The button resolves its state from
  // the module-singleton auth store, so the two variants cannot co-exist on a
  // docs page: whichever seed ran last would decide for both.
  tags: ["!autodocs"],
  parameters: { layout: "centered" },
  argTypes: {
    session: { control: "inline-radio", options: ["present", "absent"] },
  },
  args: { session: "present" },
  render: (args) => (
    <WithCloudSession session={args.session}>
      <RestoreCloudCredentialButton />
    </WithCloudSession>
  ),
};

export default meta;

type Story = StoryObj<RestoreStoryArgs>;

/** Signed in: the slot offers the repair. */
export const SignedIn: Story = {};

/**
 * Signed out: the repair would fail after the press, so the slot asks for the
 * sign-in first.
 */
export const SignedOut: Story = { args: { session: "absent" } };
