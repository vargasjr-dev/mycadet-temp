import type { Meta, StoryObj } from "@storybook/react-vite";
import { AvatarWave } from "@design/components/avatar-wave";

const meta: Meta<typeof AvatarWave> = {
  title: "Components/AvatarWave",
  component: AvatarWave,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div
        style={{
          height: 900,
          maxWidth: 620,
          position: "relative",
          background: "var(--surface-base)",
        }}
      >
        <Story />
      </div>
    ),
  ],
  args: { className: "absolute inset-0" },
};
export default meta;
type Story = StoryObj<typeof AvatarWave>;
export const Column: Story = {};
export const Wrap: Story = { args: { variant: "wrap" } };
