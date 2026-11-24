# SAI-JS docs website

Single landing page (root `README.md`, LikeC4 `index` view from `../` (C4 sources), and YouTube embeds from `src/data/playlist.ts`) plus two generated extras: the repository OpenWiki at `/openwiki/` and the Playwright report at `/journeys/`.

## Commands

From the repository root (after `npm install`):

```bash
cd docs/website
npm run dev    # runs LikeC4 codegen, then Astro dev server
npm run build  # LikeC4 codegen, `astro build`, then the OpenWiki export → `dist/`
npm run preview
```

`codegen:likec4` targets the `docs/` folder (parent of this package) so `architecture.c4` and related files are included. Regenerates `public/likec4-webcomponent.js` before dev/build.

Video list is kept in sync with [this YouTube playlist](https://www.youtube.com/playlist?list=PLXBho_YohPB09B_ecOsABoI8Dc67v1H4O); update `src/data/playlist.ts` when the playlist changes (e.g. list with `yt-dlp --flat-playlist --print "%(id)s|%(title)s" "<url>"`).

## OpenWiki (`/openwiki/`)

The generated wiki in [`../../openwiki`](../../openwiki) is published with OpenWiki's own
static visualizer, so it keeps its original UI (graph, page index, theme toggle):

```bash
npm run codegen:openwiki  # openwiki visualize ../../openwiki --export dist/openwiki
```

`postbuild` runs it after `astro build`. The visualizer is a self-contained directory with
relative asset URLs, so it works at any subpath (`/openwiki/` on the custom domain or
`/<repo>/openwiki/` on `github.io`). Regenerate the wiki with the OpenWiki skill/CLI;
the next site build exports it. The CLI version is pinned in `package.json` to the one that
generated the wiki (see `openwiki/.last-update.json`) and is fetched with `npx` on demand.

`turbo.json` in this package adds `openwiki/**` to the build inputs so a wiki-only change is
not served from the Turborepo cache.

## Playwright journeys (`/journeys/`)

The Pages workflow exports the Dagger Playwright HTML report into `dist/journeys` after the
Astro build, and the landing page's **Journeys** nav link opens it in a new tab. A plain
`npm run build` does not create it, so that link only resolves after the workflow export or an
explicit `dagger playwright-report directory ... export --path=dist/journeys`.

## GitHub Pages

On push to `main`, [.github/workflows/docs-website-github-pages.yml](../../.github/workflows/docs-website-github-pages.yml) builds this package, exports the wiki and Playwright report into `dist/`, and deploys `dist/` to GitHub Pages. The **OpenWiki** and **Journeys** nav links open in a new tab.

**One-time repo setup:** Settings → Pages → Build and deployment → **Source: GitHub Actions** (not “Deploy from a branch”).

**Custom domain (e.g. [sai.js.org](https://sai.js.org)) at the site root** — The default build uses `base: /<repo>/` for the `github.io` project URL. A custom domain is usually served at the domain root (no `/<repo>` path), so the browser requests `/<repo>/assets/...` and gets 404; files are actually at `/assets/...`. Add **Settings → Secrets and variables → Actions → Variables**:

| Variable            | Example value     | Purpose                                      |
| ------------------- | ----------------- | -------------------------------------------- |
| `PAGES_BASE_PATH`   | `/`               | Astro `base` = site root, not `/<repo>/`     |
| `PAGES_PUBLIC_URL`  | `https://sai.js.org` | Canonical `site` URL in Astro           |

If those are unset, the workflow falls back to `https://<owner>.github.io/<repo>` with `base: /<repo>/`.

## Troubleshooting

If the editor still reports errors for a removed file such as `src/content/intro.mdx`, run `npm run clean` in this folder (clears `.astro` and Vite caches) and reload the window. The docs section uses the repo root `README.md` via `ReadmeFromRepo.astro`, not MDX in `src/content/`.
