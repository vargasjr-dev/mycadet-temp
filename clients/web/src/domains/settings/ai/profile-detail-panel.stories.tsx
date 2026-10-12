import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";

import {
  configGetQueryKey,
  inferenceProviderconnectionsGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type { ProviderConnection } from "@/generated/daemon/types.gen";
import { createStoryQueryClient } from "@/lib/story-query-cache";
import { makeConfigFixture } from "@/lib/config-fixture.test-helper";

import { ProfileDetailPanel } from "./profile-detail-panel";

const ASSISTANT_ID = "story-assistant";

const CONNECTIONS: ProviderConnection[] = [
  {
    name: "anthropic-personal",
    label: null,
    provider: "anthropic",
    auth: { type: "api_key", credential: "credential/anthropic/api_key" },
    models: null,
  } as unknown as ProviderConnection,
];

const CONFIG = makeConfigFixture({
  llm: {
    profiles: {
      balanced: {
        // The managed source alone renders view mode (the daemon's
        // invariant stamp and the source coincide for cloud stubs).
        label: "Balanced",
        provider: "cadet",
        model: "glm-5.2",
      },
      "my-custom": {
        label: "My Custom",
        provider: "anthropic",
        model: "claude-opus-5",
      },
    },
    profileOrder: ["balanced", "my-custom"],
    activeProfile: "balanced",
    callSites: {},
    profileSession: { defaultTtlSeconds: 1800, maxTtlSeconds: 43200 },
    pricingOverrides: [],
  },
});

function seededClient() {
  return createStoryQueryClient((client) => {
    const path = { assistant_id: ASSISTANT_ID };
    client.setQueryData(configGetQueryKey({ path }), CONFIG);
    client.setQueryData(inferenceProviderconnectionsGetQueryKey({ path }), {
      connections: CONNECTIONS,
    });
  });
}

function withClient(client: QueryClient) {
  return function Decorator(Story: () => React.ReactElement) {
    return (
      <QueryClientProvider client={client}>
        <div className="h-[640px] w-[420px]">
          <Story />
        </div>
      </QueryClientProvider>
    );
  };
}

const meta: Meta<typeof ProfileDetailPanel> = {
  title: "Settings/AI/ProfileDetailPanel",
  component: ProfileDetailPanel,
  parameters: { layout: "centered" },
  args: {
    assistantId: ASSISTANT_ID,
    onClose: () => {},
  },
  decorators: [withClient(seededClient())],
};

export default meta;
type Story = StoryObj<typeof ProfileDetailPanel>;

export const CreateProfile: Story = {
  args: { profileName: null },
};

export const EditProfile: Story = {
  args: { profileName: "my-custom" },
};

/** Cloud profiles open read-only with a "Managed by Cadet" tag and "Save As New". */
export const CloudProfile: Story = {
  args: { profileName: "balanced" },
};
