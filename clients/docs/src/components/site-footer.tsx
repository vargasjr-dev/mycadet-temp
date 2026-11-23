import { CADET_GITHUB_REPOSITORY } from "@mycadet/shared";

const X_ICON = (
  <svg
    viewBox="0 0 24 24"
    width="17"
    height="17"
    fill="currentColor"
    aria-hidden
  >
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117Z" />
  </svg>
);

const GITHUB_ICON = (
  <svg
    viewBox="0 0 24 24"
    width="17"
    height="17"
    fill="currentColor"
    aria-hidden
  >
    <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
  </svg>
);

const COLUMNS: Array<{
  title: string;
  links: Array<{ label: string; href: string; external?: boolean }>;
}> = [
  {
    title: "Product",
    links: [
      { label: "Download", href: "/downloads" },
      { label: "Pricing", href: "/pricing" },
      { label: "Plugins", href: "/plugins" },
    ],
  },
  {
    title: "Resources",
    links: [
      { label: "Docs", href: "/docs" },
      {
        label: "Community",
        href: "https://discord.gg/ZABd9V2zM8",
        external: true,
      },
      { label: "Contact", href: "mailto:support@mycadet.ai" },
    ],
  },
  {
    title: "Legal",
    links: [
      { label: "Privacy", href: "/docs/privacy-policy" },
      { label: "Terms", href: "/docs/terms-of-use" },
    ],
  },
];

export function SiteFooter() {
  return (
    <footer className="footer">
      <div className="footer-inner">
        <div className="footer-cols">
          {COLUMNS.map((col) => (
            <div key={col.title} className="footer-col">
              <h4>{col.title}</h4>
              {col.links.map((link) => (
                <a
                  key={link.label}
                  href={link.href}
                  {...(link.external
                    ? { target: "_blank", rel: "noopener noreferrer" }
                    : {})}
                >
                  {link.label}
                </a>
              ))}
            </div>
          ))}
        </div>
        <div className="footer-base">
          <span>
            © 2026 <a href="https://vargasjr.dev">Vargas JR LLC</a>
          </span>
          <div className="footer-social">
            <a
              href="https://x.com/mycadet_ai"
              aria-label="Cadet on X"
              target="_blank"
              rel="noopener noreferrer"
            >
              {X_ICON}
            </a>
            <a
              href={`https://github.com/${CADET_GITHUB_REPOSITORY}`}
              aria-label="Cadet on GitHub"
              target="_blank"
              rel="noopener noreferrer"
            >
              {GITHUB_ICON}
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
