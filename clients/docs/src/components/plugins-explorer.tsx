"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { CatalogRow } from "@/lib/plugins-catalog";

// Ported verbatim from mycadet-cloud's plugins explorer. The row shape +
// response parsing live in lib/plugins-catalog (server safe) — this file
// is only the explorer UI.

const PAGE_SIZE = 9;

export function PluginsExplorer({ plugins }: { plugins: CatalogRow[] }) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All");
  const [page, setPage] = useState(1);

  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const plugin of plugins) {
      const key = plugin.category ?? "Other";
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [
      { label: "All", count: plugins.length },
      ...[...counts.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([label, count]) => ({ label, count })),
    ];
  }, [plugins]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return plugins.filter((plugin) => {
      if (category !== "All" && (plugin.category ?? "Other") !== category) {
        return false;
      }
      if (!q) {return true;}
      return (
        plugin.name.toLowerCase().includes(q) ||
        (plugin.description ?? "").toLowerCase().includes(q)
      );
    });
  }, [plugins, query, category]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const visible = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <section className="plugins-explorer">
      <input
        className="plugins-search"
        type="search"
        placeholder="Search plugins…"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setPage(1);
        }}
      />
      <div className="plugins-pills">
        {categories.map(({ label, count }) => (
          <button
            key={label}
            type="button"
            className={label === category ? "plugin-pill on" : "plugin-pill"}
            onClick={() => {
              setCategory(label);
              setPage(1);
            }}
          >
            {label} <span>{count}</span>
          </button>
        ))}
      </div>
      <div className="plugins-grid">
        {visible.map((plugin) => (
          <Link
            key={plugin.name}
            href={`/plugins/${encodeURIComponent(plugin.name)}`}
            className="plugin-card"
          >
            <span className="plugin-icon">{plugin.icon ?? "🧩"}</span>
            <span className="plugin-name">{plugin.name}</span>
            {plugin.description ? (
              <span className="plugin-desc">{plugin.description}</span>
            ) : null}
            <span className="plugin-meta">
              {plugin.category ?? "Other"}
              {plugin.license ? ` · ${plugin.license}` : ""}
            </span>
          </Link>
        ))}
      </div>
      {filtered.length === 0 ? (
        <p className="plugins-empty">No plugins match “{query}”.</p>
      ) : null}
      {pageCount > 1 ? (
        <nav className="plugins-pagination" aria-label="Plugin pages">
          <button
            type="button"
            aria-label="Previous page"
            disabled={page === 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            ←
          </button>
          <span className="plugins-page-indicator">
            Page {page} of {pageCount}
          </span>
          <button
            type="button"
            aria-label="Next page"
            disabled={page === pageCount}
            onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
          >
            →
          </button>
        </nav>
      ) : null}
    </section>
  );
}
