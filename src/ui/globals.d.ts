declare module "*.css";

/**
 * Asset imports resolve to the URL string Vite rewrites to a hashed file
 * (`logo.png` -> `assets/logo-<hash>.png`). Vite ships its own client types in
 * `vite/client`, but this project does not reference them, so `*.png` is declared here
 * rather than adding a `types` entry for one module kind.
 */
declare module "*.png" {
  const src: string;
  export default src;
}

/**
 * `?inline` CSS imports.
 *
 * `content_overlay.ts` pulls the overlay stylesheet in as a *string* so it can install
 * it on a `<style>` element inside the overlay's shadow root. That specifier is
 * resolved by hand in `scripts/build-bundles.js`'s `cssTextPlugin()`, not by a
 * bundler plugin, so TypeScript has no way to infer it and needs to be told.
 */
declare module "*.css?inline" {
  const css: string;
  export default css;
}
