import { authEndpoint } from "@app/lib/auth/auth-endpoint";

export function getCsrfToken(): string | undefined {
  const key = import.meta.env.PROD ? "__Secure-csrftoken" : "csrftoken";
  return document.cookie
    .split("; ")
    .findLast((entry) => entry.startsWith(`${key}=`))
    ?.split("=")
    .slice(1)
    .join("=");
}
let bootstrap: Promise<void> | undefined;
export async function ensureCsrfCookie(): Promise<void> {
  if (getCsrfToken()) return;
  bootstrap ??= (async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await fetch(authEndpoint("auth/session"), {
          credentials: "same-origin",
        });
        if (getCsrfToken()) return;
      } catch {
        if (attempt === 0)
          await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  })().finally(() => {
    bootstrap = undefined;
  });
  await bootstrap;
}
