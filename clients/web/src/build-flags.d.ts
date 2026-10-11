/**
 * Build-time split flags, replaced with literals by vite `define` (see
 * `vite.config.ts`). Global-script declarations on purpose: no imports or
 * exports, so the identifier is ambient and vite's textual replacement
 * reaches every call site — rollup then folds the dead branch and
 * tree-shakes the excluded route chunks out of the artifact.
 *
 * Under `bun test` there is no vite define; `test-setup.ts` seeds the
 * global with the desktop shape (everything included), which is what the
 * route-tree tests assert against.
 *
 * __INCLUDES_ACCOUNT__: whether this artifact carries the account subtree
 * (`/account` — auth screens, assistant selection, the cloud-callback
 * loopback). The served cloud build (`VITE_CLOUD_MODE=true`) drops
 * it: account-level flows belong to the desktop shell, and the iframed
 * assistant surface neither reaches nor ships them.
 */
declare const __INCLUDES_ACCOUNT__: boolean;
