import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { fetchPluginReadme, loadCatalog } from "@/lib/plugins-catalog";
import { routes } from "@/lib/routes";

type Params = { params: Promise<{ name: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { name } = await params;
  const plugins = await loadCatalog();
  const plugin = plugins?.find((p) => p.name === name);
  if (!plugin) {return { title: "Plugin not found — Cadet" };}
  return {
    title: `${plugin.name} — Cadet Plugins`,
    description: plugin.description,
  };
}

// The page's own title already names the plugin, so a README's leading H1
// would render twice.
function readmeBody(content: string): string {
  return content.replace(/^#\s+[^\n]*\n+/, "");
}

export default async function PluginDetail({ params }: Params) {
  const { name } = await params;
  const plugins = await loadCatalog();

  // A down catalog means "unknown", not "missing" — say so instead of 404.
  if (plugins === null) {
    return (
      <main className="plugin-detail">
        <Link href="/plugins" className="plugin-back">
          ← Back to Plugins
        </Link>
        <p className="plugin-unavailable">
          The plugin catalog is temporarily unavailable.
        </p>
      </main>
    );
  }

  const plugin = plugins.find((p) => p.name === name);
  if (!plugin) {notFound();}

  const readme = await fetchPluginReadme(plugin);

  return (
    <main className="plugin-detail">
      <Link href="/plugins" className="plugin-back">
        ← Back to Plugins
      </Link>
      <header className="plugin-hero">
        <span className="plugin-icon-lg" aria-hidden>
          {plugin.icon ?? "🧩"}
        </span>
        <h1>{plugin.name}</h1>
        {plugin.description ? (
          <p className="plugin-desc">{plugin.description}</p>
        ) : null}
        <div className="plugin-cta-row">
          {/* The cloud app's SessionCta (signed-in/out swap) stays behind —
              this app carries no auth. Installs happen through the
              assistant, so the pill points at the cloud signup where the
              flow starts. */}
          <a href={routes.signup} className="btn">
            Add to your Cadet
          </a>
        </div>
      </header>
      <hr className="plugin-divider" />
      {readme.ok ? (
        <article className="plugin-readme">
          <Markdown remarkPlugins={[remarkGfm]}>
            {readmeBody(readme.content)}
          </Markdown>
        </article>
      ) : (
        <div className="plugin-readme-fallback">
          <p>
            The README for this plugin isn&apos;t readable here yet — its source
            repo may be private.
          </p>
        </div>
      )}
    </main>
  );
}
