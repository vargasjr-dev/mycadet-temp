import ICU from "i18next-icu";

import { FALLBACK_CATALOGS } from "./src/i18n/catalogs";
import { i18nextInitOptions } from "./src/i18n/config";
import { i18next } from "./src/i18n/instance";

await i18next
  .use(new ICU())
  .init(i18nextInitOptions("en", { en: FALLBACK_CATALOGS }));

// App owns its account routes independently of the web build surface.
Object.assign(globalThis, { __INCLUDES_ACCOUNT__: false });
