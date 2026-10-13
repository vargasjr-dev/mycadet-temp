import {
  ExternalAnchor as SharedExternalAnchor,
  type ExternalAnchorProps,
} from "@mycadet/design-library/components/external-anchor";

import { handleNativeAnchorClick } from "@/utils/native-anchor";

export {
  ExternalLinkGlyph,
  isWebUrl,
} from "@mycadet/design-library/components/external-anchor";

export function ExternalAnchor(props: Omit<ExternalAnchorProps, "onClick">) {
  return (
    <SharedExternalAnchor
      {...props}
      onClick={(event) => handleNativeAnchorClick(event, props.href)}
    />
  );
}
