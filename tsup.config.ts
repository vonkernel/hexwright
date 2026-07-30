import { defineConfig } from "tsup";

/**
 * Two bundles.
 *
 * cli    — ESM for node. Dependencies stay external; npm installs them.
 * client — IIFE for the browser, cytoscape inlined. Without it, a published
 *   `serve` falls back to bundling with esbuild at runtime — and esbuild is a
 *   devDependency, so it is not installed and the web UI comes up blank.
 */
export default defineConfig([
  {
    entry: { cli: "src/cli.ts" },
    format: ["esm"],
    target: "node22",
    clean: true,
    banner: { js: "#!/usr/bin/env node" },
  },
  {
    entry: { client: "src/view/client.ts" },
    format: ["iife"],
    target: "es2022",
    platform: "browser",
    minify: true,
    noExternal: [/.*/],
    outExtension: () => ({ js: ".js" }),
  },
]);
