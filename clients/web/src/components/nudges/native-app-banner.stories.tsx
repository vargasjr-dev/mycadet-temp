/**
 * The in-chat banner that offers the native app to a mobile web reader.
 *
 * `resolveMobilePromotion` picks one of three targets, and the banner reads
 * the copy off the one it is handed. iOS and Android name their platform and
 * link their store listing. Generic names neither — for the mobile browsers
 * the OS checks could not identify — and sends those readers to the Cadet
 * downloads page instead.
 *
 * The subtitle and the CTA label are shared by all three.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";

import { NativeAppBanner } from "@/components/nudges/native-app-banner";
import { resolveMobilePromotion } from "@/hooks/use-native-app-nudge";

const meta: Meta<typeof NativeAppBanner> = {
  title: "Nudges/NativeAppBanner",
  component: NativeAppBanner,
  parameters: { layout: "padded" },
  args: {
    promotion: resolveMobilePromotion("ios"),
    onDownload: () => {},
    onDismiss: () => {},
  },
  decorators: [
    (Story) => (
      <div className="mx-auto w-full max-w-[720px]">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof NativeAppBanner>;

/** iOS web, off Safari: the App Store listing, with the cloud named. */
export const IOS: Story = {
  name: "iOS · App Store",
};

/**
 * Android web on a deployment that configured its Play Store listing. Without
 * that configuration this reader gets the Generic story below instead.
 */
export const Android: Story = {
  name: "Android · Play Store",
  args: { promotion: resolveMobilePromotion("android") },
};

/**
 * The fallback: a mobile browser we could not identify, or Android with no
 * store listing configured. No platform is named anywhere, including in the
 * banner's `aria-label` and the CTA's, and the CTA opens the downloads page.
 */
export const Generic: Story = {
  name: "Generic · downloads page",
  args: { promotion: resolveMobilePromotion(null) },
};

/**
 * Phone width, which is the only width this banner actually ships at. Below
 * `md` the row tightens its gap, the subtitle steps up a size, and the
 * dismiss button regains its left margin, so the desktop stories above show a
 * treatment no reader of this banner sees.
 */
export const Mobile: Story = {
  name: "Mobile treatment",
  globals: { viewport: { value: "sbMobile", isRotated: false } },
};
