// @ts-check
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "astro/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Monorepo root (so `README.md` and Vite can watch it for HMR + builds). */
const monorepoRoot = path.resolve(__dirname, "../..");

/**
 * GitHub Pages (project site) uses a subpath — set in the deploy workflow via
 * ASTRO_SITE and ASTRO_BASE_PATH. Local dev: unset → defaults below and base "/".
 */
const site = process.env.ASTRO_SITE || "https://janeirodigital.org";
const base = process.env.ASTRO_BASE_PATH || "/";

export default defineConfig({
  site,
  base,
  build: { assets: "assets" },
  vite: {
    // Allow importing the root README (outside `docs/website/`); Vite tracks it for dev HMR and production builds.
    server: { fs: { allow: [monorepoRoot] } },
    ssr: { noExternal: ["marked"] },
  },
});
