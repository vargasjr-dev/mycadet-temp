import type { Meta, StoryObj } from "@storybook/react-vite";
import { ExternalAnchor } from "./external-anchor";

const meta: Meta<typeof ExternalAnchor> = {
  title: "Components/ExternalAnchor",
  component: ExternalAnchor,
  args: {
    href: "https://example.com",
    children: "Read documentation",
    tone: "default",
  },
  argTypes: {
    tone: { control: "inline-radio", options: [undefined, "default", "quiet"] },
    glyph: { control: "boolean" },
  },
};

export default meta;
type Story = StoryObj<typeof ExternalAnchor>;
export const Default: Story = {};
export const Quiet: Story = { args: { tone: "quiet" } };
export const WithoutGlyph: Story = { args: { glyph: false } };
export const Email: Story = {
  args: { href: "mailto:help@example.com", children: "Email support" },
};
