import type { Plugin } from "esbuild";

/**
 * zod's `z` namespace re-exports every error-message locale (~45 languages, most of zod's weight
 * in the bundle). The plugin never shows zod messages to the user and only uses the default
 * English one, so the locale index is replaced with English alone.
 */
export const onlyEnglishZodLocale: Plugin = {
  name: "zod-only-en-locale",
  setup(b) {
    b.onResolve({ filter: /\/locales\/index\.js$/ }, (args) =>
      /[\\/]zod[\\/]/.test(args.importer)
        ? { path: args.importer, namespace: "zod-locales" }
        : undefined,
    );
    b.onLoad({ filter: /.*/, namespace: "zod-locales" }, (args) => ({
      contents: `export { default as en } from ${JSON.stringify(args.path.replace(/[\\/](classic|core)[\\/][^\\/]+$/, "/locales/en.js"))};`,
      resolveDir: args.path.replace(/[\\/][^\\/]+$/, ""),
      loader: "js",
    }));
  },
};
