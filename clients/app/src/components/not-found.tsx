/**
 * The app shell's not-found state: a quiet line where a route (or a disabled
 * page) has nothing to render. The web bundle's NotFound is a full animated
 * landing; the shell needs only the honest sentence.
 */
export function NotFound() {
  return (
    <main className="flex min-h-svh items-center justify-center bg-[var(--surface-base)] px-6 py-10 text-[var(--content-default)]">
      <p className="text-body-medium-lighter text-[var(--content-secondary)]">
        Page not found
      </p>
    </main>
  );
}
