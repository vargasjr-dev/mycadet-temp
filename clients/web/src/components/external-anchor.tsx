import {
  ExternalAnchor as SharedExternalAnchor,
  type ExternalAnchorProps,
} from "@mycadet/design-library/components/external-anchor";

import { handleNativeAnchorClick } from "@/utils/native-anchor";

export function ExternalAnchor({
  onOpen,
  ...props
}: Omit<ExternalAnchorProps, "onClick"> & { onOpen?: () => void }) {
  return (
    <SharedExternalAnchor
      {...props}
      onClick={(event) => {
        onOpen?.();
        handleNativeAnchorClick(event, props.href);
      }}
    />
  );
}
