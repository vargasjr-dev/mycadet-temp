import { plugin } from "bun";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
window.location.href = "http://localhost:3001";
process.env.VITE_CLOUD_MODE = "true";

plugin({
  name: "app-vite-asset-urls",
  setup(build) {
    build.onLoad({ filter: /\?(worker&url|url|worker)$/ }, (args) => ({
      contents: `export default ${JSON.stringify(args.path)};`,
      loader: "js",
    }));
  },
});

// Radix focus scopes can re-enter happy-dom's focus before it updates activeElement.
const focus = window.HTMLElement.prototype.focus;
const focusing = new Set<HTMLElement>();
window.HTMLElement.prototype.focus = function (
  ...args: Parameters<typeof focus>
): void {
  if (focusing.has(this)) {
    return;
  }
  focusing.add(this);
  try {
    focus.apply(this, args);
  } finally {
    focusing.delete(this);
  }
};
