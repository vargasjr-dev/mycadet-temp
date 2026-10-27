import type { Meta, StoryObj } from "@storybook/react-vite";

import { RestoreCloudCredentialButton } from "@/domains/chat/components/restore-cloud-credential-button";

const meta: Meta = {
  title: "Chat/RestoreCloudCredentialButton",
  parameters: { layout: "centered" },
  render: () => <RestoreCloudCredentialButton />,
};

export default meta;

type Story = StoryObj;

/**
 * The repair rotates the credential through the cloud. Web no longer gates
 * the affordance on session state: the repair runs and surfaces a cloud
 * failure through its own error toasts when the credential source is
 * unreachable, so there is a single variant.
 */
export const Default: Story = {};
