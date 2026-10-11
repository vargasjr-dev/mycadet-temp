import { type ReactNode } from "react";

import { Notice } from "@mycadet/design-library/components/notice";

import { PlatformLoginButton } from "@/components/cloud-login-button";

interface CloudLoginNoticeProps {
  /**
   * Why the surface needs a cloud session — typically the existing
   * "Log in to Cadet Cloud to {action}." sentence.
   */
  children: ReactNode;
  /** Forwarded to the underlying `Notice` (e.g. layout spacing). */
  className?: string;
}

/**
 * Info notice shown when `useCloudGate()` returns `"disabled"`: the
 * surface is meaningful but there is no platform session. Pairs the
 * explanatory copy with {@link PlatformLoginButton} so the prompt isn't a
 * dead end. A surface with no room for a notice (an action slot on a banner)
 * renders the button on its own.
 */
export function CloudLoginNotice({
  children,
  className,
}: CloudLoginNoticeProps) {
  return (
    <Notice tone="info" className={className} actions={<PlatformLoginButton />}>
      {children}
    </Notice>
  );
}
