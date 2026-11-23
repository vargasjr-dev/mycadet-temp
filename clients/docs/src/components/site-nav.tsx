import Image from "next/image";
import Link from "next/link";
import { Ellipsis } from "lucide-react";

import { navItems } from "@/lib/nav-items";

/**
 * Ported from mycadet-cloud's SiteNav. The session-aware account CTA
 * (NavSessionArea's client-side probe of /account) stays behind in the
 * cloud app for now — this static "Get started" pill keeps the layout
 * without dragging auth into the docs app. Same swap-in point when the
 * marketing frontend fully moves over.
 */
export function SiteNav() {
  return (
    <header className="nav">
      <div className="nav-brand">
        <Link href="/" aria-label="Cadet home">
          <Image
            src="/docs/mycadet-logo.svg"
            alt="Cadet logo"
            width={32}
            height={32}
          />
        </Link>
      </div>
      <nav className="nav-links">
        {navItems.map((item) => (
          <a
            key={item.label}
            href={item.href}
            className="nav-link"
            {...(item.external
              ? { target: "_blank", rel: "noopener noreferrer" }
              : {})}
          >
            {item.label}
          </a>
        ))}
      </nav>
      <details className="nav-mobile">
        <summary aria-label="More navigation options">
          <Ellipsis size={24} aria-hidden="true" />
        </summary>
        <nav className="nav-mobile-links" aria-label="Mobile navigation">
          {navItems.map((item) => (
            <a
              key={item.label}
              href={item.href}
              className="nav-link"
              {...(item.external
                ? { target: "_blank", rel: "noopener noreferrer" }
                : {})}
            >
              {item.label}
            </a>
          ))}
          <a href="/account/signup" className="btn">
            Get started
          </a>
        </nav>
      </details>
      <div className="nav-cta">
        <a href="/account/signup" className="btn">
          Get started
        </a>
      </div>
    </header>
  );
}
