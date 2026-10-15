# Embedding app in a host

`@mycadet/app` exports `AppShell`. `@mycadet/app/contracts` exports the Zod
schemas and types for assistant resolution. The public entry imports React,
Zod, and the portable shell only. It does not create a root, install a router,
initialize account state, or import Web, Vite, or native plugins.

This first entry covers assistant hosting. Existing account routes and the
standalone prototype entry are not part of this portable surface yet.

## Resolution contract

The host implements `ResolveAssistant`. It receives an optional selected
assistant id and an abort signal, and returns one of these JSON shapes:

- `{ status: "unauthenticated" }`
- `{ status: "empty" }`
- `{ status: "starting" }`
- `{ status: "ready", assistant: { id, ui: { version, entryUrl }, runtime: { baseUrl } } }`

For example:

```json
{
  "status": "ready",
  "assistant": {
    "id": "assistant-1",
    "ui": {
      "version": "1.2.3",
      "entryUrl": "/runtime/assistant-1/web/1.2.3/assistant/"
    },
    "runtime": { "baseUrl": "/runtime/assistant-1/v1/" }
  }
}
```

URLs are public root-relative paths or HTTPS URLs; HTTP is allowed for
loopback development. They contain no account credentials, query parameters,
or fragments. `entryUrl` ends at the assistant UI root, `/assistant/`.
App maps the host route onto that root, preserving deep links, search, and hash.

The host must authorize the selection and bind the UI entry to the same
assistant as `runtime.baseUrl`. A UI version alone does not identify an
assistant. The host serves or configures that entry so the assistant's runtime
requests reach its scoped proxy. App does not append credentials or invent a
runtime configuration message for existing bundles. The descriptor's runtime
base also participates in frame identity: a different binding remounts the UI.

There is no new HTTP endpoint in this change. Platform and site adapters must
implement resolution against their server-side account/runtime authorities.
An internal endpoint requiring a server secret must remain on the server.
Those adapters and the assistant-only runtime bootstrap still need an
end-to-end verification before either site switches to this entry.

## Next.js host

A thin client wrapper owns Next navigation and supplies the resolver. This is
an illustrative `/api/assistant/resolve` route, which the host must implement;
it is not an endpoint supplied by this package.

```tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AppShell } from "@mycadet/app";
import type { ResolveAssistant } from "@mycadet/app/contracts";

const resolveAssistant: ResolveAssistant = async ({ assistantId, signal }) => {
  const query = new URLSearchParams();
  if (assistantId) {
    query.set("assistantId", assistantId);
  }
  const response = await fetch(`/api/assistant/resolve?${query}`, {
    credentials: "same-origin",
    signal,
  });
  if (response.status === 401) {
    return { status: "unauthenticated" };
  }
  if (!response.ok) {
    throw new Error("Assistant resolution failed");
  }
  return response.json();
};

export function AssistantHost({
  origin,
  mountPath = "/assistant",
}: {
  origin: string;
  mountPath?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const [hash, setHash] = useState("");
  useEffect(() => {
    const updateHash = () => setHash(window.location.hash);
    updateHash();
    window.addEventListener("popstate", updateHash);
    window.addEventListener("hashchange", updateHash);
    return () => {
      window.removeEventListener("popstate", updateHash);
      window.removeEventListener("hashchange", updateHash);
    };
  }, []);
  const onNavigate = useCallback(
    (path: string, { replace }: { replace: boolean }) => {
      setHash(new URL(path, origin).hash);
      if (replace) {
        router.replace(path, { scroll: false });
      } else {
        router.push(path, { scroll: false });
      }
    },
    [router, origin],
  );
  return (
    <AppShell
      origin={origin}
      mountPath={mountPath}
      location={`${pathname}${search ? `?${search}` : ""}${hash}`}
      resolveAssistant={resolveAssistant}
      onNavigate={onNavigate}
    />
  );
}
```

Use `/assistant` for the platform and `/admin/assistant` for the admin shell.
The host needs a catch-all route under its mount and a Suspense boundary where
Next requires one for `useSearchParams`. Keep the resolver reference stable.
Key the shell by the host's account/session identity when it changes, so the
old account's frame unmounts immediately. `renderStatus` supplies localized
loading, readiness, error, and account-login UI; no account state is passed to
the iframe.

Frame navigation accepts the existing `mycadet-web-nav` protocol only from the
active frame and its exact origin. The parent sends
`mycadet-web-parent-nav` for host back/forward without resetting the iframe
source. Canonical `/assistant/*` and the selected entry's version-prefixed
paths are accepted. Unrelated routes are rejected.

## Local package artifact

Run `bun run build:package` in `clients/app`. It produces `dist/package`,
including ESM entries, declaration files, and a package manifest with React as
a peer and Zod as a dependency. Workspace-only dependencies are not required
by this artifact. Its root preserves the `use client` directive; the contracts
entry can be imported on a server.

To create an installable archive, run `bun pm pack` from `dist/package`.
This builds a local artifact only. It does not publish a package or deploy a
host. Cross-repository distribution and host adoption are separate steps.
