/**
 * The mobile-app card in Settings → General. It renders for every mobile web
 * visitor, and the promotion it is handed decides the copy and the store link.
 *
 * - **iOS**: the App Store listing.
 * - **Android**: the Play listing.
 * - **Generic**: every mobile browser the iOS and Android checks did not
 *   claim. It drops the cloud name from the copy and points at the
 *   downloads page.
 *
 * Desktop sees none of these: `NativeAppCard` renders `null` there, and macOS
 * gets its own nudge.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";

import { NativeAppCardView } from "@/domains/settings/components/native-app-card-view";
import { resolveMobilePromotion } from "@/hooks/use-native-app-nudge";

const meta: Meta<typeof NativeAppCardView> = {
  title: "Settings/NativeAppCard",
  component: NativeAppCardView,
  args: {
    promotion: resolveMobilePromotion("ios"),
  },
  decorators: [
    (Story) => (
      <div className="mx-auto w-full max-w-[560px] p-6">
        <Story />
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof NativeAppCardView>;

/** An iOS browser outside Safari, where the Smart App Banner is absent. */
export const IOS: Story = {
  name: "iOS",
};

/** An Android browser, with the Play listing configured for this build. */
export const Android: Story = {
  args: { promotion: resolveMobilePromotion("android") },
};

/**
 * The fallback: no platform name in the copy, and the CTA opens the downloads
 * page rather than a store listing.
 */
export const Generic: Story = {
  args: { promotion: resolveMobilePromotion(null) },
};
