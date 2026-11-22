"use client";
import { useEffect, useState, type ReactElement } from "react";
import type { EmbeddedAppProps } from "./app-shell-props";
import { RouterProvider } from "react-router";
import { createAppRouter } from "./standalone";
import { initI18n } from "./i18n";

/** Browser-only app route tree, with an explicit mount independent of API paths. */
export function EmbeddedApp({
  basename = "/",
}: EmbeddedAppProps): ReactElement | null {
  const [router, setRouter] = useState<ReturnType<typeof createAppRouter>>();
  useEffect(() => {
    let active = true;
    let current: ReturnType<typeof createAppRouter> | undefined;
    void initI18n().then(() => {
      if (!active) return;
      current = createAppRouter(basename);
      setRouter(current);
    });
    return () => {
      active = false;
      current?.dispose();
    };
  }, [basename]);
  return router ? <RouterProvider router={router} /> : null;
}
