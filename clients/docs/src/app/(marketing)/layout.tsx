import type { ReactNode } from "react";

import { SiteFooter } from "@/components/site-footer";
import { SiteNav } from "@/components/site-nav";

import "./marketing.css";

/**
 * Shared chrome for the marketing pages (community, downloads, and the
 * rest as they move over from mycadet-cloud): the same nav bar on every
 * page and one footer. The docs pages keep their own chrome by living in
 * the (documentation) route group. Mirrors mycadet-cloud's
 * app/(marketing)/layout.tsx — the two converge as the marketing
 * frontend becomes open source here.
 */
export default function MarketingLayout({ children }: { children: ReactNode }) {
  return (
    <div
      className="marketing"
      style={{ minHeight: "100dvh", display: "flex", flexDirection: "column" }}
    >
      <SiteNav />
      {children}
      <SiteFooter />
    </div>
  );
}
