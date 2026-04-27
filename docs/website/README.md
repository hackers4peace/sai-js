# SAI-JS docs website

Single static page: root `README.md`, LikeC4 `index` view from `../` (C4 sources), and YouTube embeds from `src/data/playlist.ts`.

## Commands

From the repository root (after `npm install`):

```bash
cd docs/website
npm run dev    # runs LikeC4 codegen, then Astro dev server
npm run build  # codegen + `astro build` → `dist/`
npm run preview
```

`codegen:likec4` targets the `docs/` folder (parent of this package) so `architecture.c4` and related files are included. Regenerates `public/likec4-webcomponent.js` before dev/build.

Video list is kept in sync with [this YouTube playlist](https://www.youtube.com/playlist?list=PLXBho_YohPB09B_ecOsABoI8Dc67v1H4O); update `src/data/playlist.ts` when the playlist changes (e.g. list with `yt-dlp --flat-playlist --print "%(id)s|%(title)s" "<url>"`).

## GitHub Pages

On push to `main`, [.github/workflows/docs-website-github-pages.yml](../../.github/workflows/docs-website-github-pages.yml) builds this package and deploys `dist/` to GitHub Pages.

**One-time repo setup:** Settings → Pages → Build and deployment → **Source: GitHub Actions** (not “Deploy from a branch”).

**Custom domain (e.g. [sai.js.org](https://sai.js.org)) at the site root** — The default build uses `base: /<repo>/` for the `github.io` project URL. A custom domain is usually served at the domain root (no `/<repo>` path), so the browser requests `/<repo>/assets/...` and gets 404; files are actually at `/assets/...`. Add **Settings → Secrets and variables → Actions → Variables**:

| Variable            | Example value     | Purpose                                      |
| ------------------- | ----------------- | -------------------------------------------- |
| `PAGES_BASE_PATH`   | `/`               | Astro `base` = site root, not `/<repo>/`     |
| `PAGES_PUBLIC_URL`  | `https://sai.js.org` | Canonical `site` URL in Astro           |

If those are unset, the workflow falls back to `https://<owner>.github.io/<repo>` with `base: /<repo>/`.

## Troubleshooting

If the editor still reports errors for a removed file such as `src/content/intro.mdx`, run `npm run clean` in this folder (clears `.astro` and Vite caches) and reload the window. The docs section uses the repo root `README.md` via `ReadmeFromRepo.astro`, not MDX in `src/content/`.
