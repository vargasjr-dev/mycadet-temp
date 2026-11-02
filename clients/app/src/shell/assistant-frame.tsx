"use client";

import { useEffect, useRef, useState } from "react";
import { AssistantNavigationSchema } from "../assistant/resolution-contract";
import { framePath, frameUrl, hostPath } from "./assistant-navigation";

export interface AssistantFrameProps {
  location: string;
  mountPath: string;
  onNavigate(path: string, options: { replace: boolean }): void;
  title: string;
}

export function AssistantFrame({
  location,
  mountPath,
  onNavigate,
  title,
}: AssistantFrameProps) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [src] = useState(() => frameUrl(location, mountPath));
  const currentPath = useRef(framePath(location, mountPath));
  const frameOrigin = new URL(src).origin;
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
      try {
        const target = hostPath(message.data.path, mountPath);
        const targetFramePath = framePath(target, mountPath);
        if (targetFramePath === currentPath.current) {
          return;
        }
        currentPath.current = targetFramePath;
        onNavigate(target, { replace: message.data.nav !== "push" });
      } catch {
        // Frames can announce only assistant routes inside the host mount.
      }
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [frameOrigin, mountPath, onNavigate]);

  useEffect(() => {
    const next = framePath(location, mountPath);
    if (next !== currentPath.current) {
      currentPath.current = next;
      ref.current?.contentWindow?.postMessage(
        { source: "mycadet-web-parent-nav", path: next },
        frameOrigin,
      );
    }
  }, [location, mountPath, frameOrigin]);

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
