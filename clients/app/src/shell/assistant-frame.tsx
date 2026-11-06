"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AssistantNavigationSchema } from "../assistant/resolution-contract";

export interface AssistantFrameProps {
  onNavigate(path: string, options: { replace: boolean }): void;
  title: string;
}

const mount = "/web";

function frameUrl(): string {
  return `${mount}${location.pathname}${location.search}${location.hash}`;
}

export function AssistantFrame({ onNavigate, title }: AssistantFrameProps) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [src] = useState(frameUrl);
  const currentPath = useRef(src);
  const frameOrigin = useMemo(() => window.location.origin, []);
  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (
        event.source !== ref.current?.contentWindow ||
        event.origin !== frameOrigin
      ) {
        return;
      }
      const message = AssistantNavigationSchema.safeParse(event.data);
      if (!message.success) {
        return;
      }
      if (message.data.path === currentPath.current) {
        return;
      }
      currentPath.current = message.data.path;
      const target = currentPath.current.replace(new RegExp(`^\\${mount}`), "");
      onNavigate(target, { replace: message.data.nav === "replace" });
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [frameOrigin, onNavigate]);

  useEffect(() => {
    const next = frameUrl();
    if (next !== currentPath.current) {
      currentPath.current = next;
      ref.current?.contentWindow?.postMessage(
        { source: "mycadet-web-parent-nav", path: next },
        frameOrigin,
      );
    }
  }, [location, frameOrigin]);

  return (
    <iframe
      ref={ref}
      src={src}
      onLoad={() =>
        ref.current?.contentWindow?.postMessage(
          { source: "mycadet-web-parent-nav", path: currentPath.current },
          frameOrigin,
        )
      }
      title={title}
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
      allow="microphone; camera; clipboard-write"
      style={{ width: "100%", height: "100%", minHeight: "100dvh", border: 0 }}
    />
  );
}
