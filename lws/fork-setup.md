# Using `hackers4peace/CommunitySolidServer#lws-next-major` in `sai-js`

## 1. Set up the fork branch

```bash
cd ~/code/solid
git clone git@github.com:hackers4peace/CommunitySolidServer.git
cd CommunitySolidServer

git remote add upstream https://github.com/CommunitySolidServer/CommunitySolidServer.git
git remote add jeswr https://github.com/jeswr/CommunitySolidServer.git
git fetch upstream versions/next-major
git fetch jeswr feat/lws-next-major

# Option A: start from the LWS PR branch
git checkout -b lws-next-major jeswr/feat/lws-next-major

# Option B: start from upstream next-major and bring the LWS work in yourself
# git checkout -b lws-next-major upstream/versions/next-major
# git cherry-pick 992ee361 275797a6 e8343362 311b3677

git push -u origin lws-next-major
```

Bump the version so npm does not confuse the fork with the published `8.0.0-alpha.3`:

```bash
npm version 8.0.0-alpha.3-lws.1 --no-git-tag-version
git add package.json package-lock.json
git commit -m "chore: mark LWS fork preview"
git push
```

Build it once locally:

```bash
npm ci
npm run build
ls dist/index.js config/lws.json config/solid-lws.json
```

The fork's `prepare` script is `npm run build`, so npm will build it again when installing from git.

---

## 2. Choose how `sai-js` consumes the fork

| Mode | Spec in `package.json` | When to use |
|---|---|---|
| Git branch | `github:hackers4peace/CommunitySolidServer#lws-next-major` | Normal development; docker/dagger/CI |
| Git commit | `github:hackers4peace/CommunitySolidServer#<sha>` | Reproducible builds |
| Local link | `npm link` (no package.json change) | Active CSS development in a sibling checkout |
| Local tarball | `file:vendor/community-solid-server-8.0.0-alpha.3-lws.1.tgz` | Docker/dagger with local changes |

For docker/dagger, **use the git URL** (or a tarball inside the repo). A sibling `file:../CommunitySolidServer` path is not visible inside the dagger build context or the docker container.

---

## 3. Edit the three `package.json` files

Use the **same spec** in all three so npm can dedupe:

### Root `package.json`

```json
"devDependencies": {
  "@solid/community-server": "github:hackers4peace/CommunitySolidServer#lws-next-major",
  ...
}
```

### `packages/components/package.json`

```json
"dependencies": {
  "@solid/community-server": "github:hackers4peace/CommunitySolidServer#lws-next-major",
  ...
}
```

### `services/css/package.json`

```json
"dependencies": {
  "@solid/community-server": "github:hackers4peace/CommunitySolidServer#lws-next-major",
  "@elfpavlik/sai-components": "file:../../packages/components"
}
```

`services/css` currently depends on the published `@elfpavlik/sai-components` rc.29, which itself depends on CSS alpha.2. Using the local components package avoids a nested alpha.2. If you prefer to keep the published components package, add an `overrides` entry in `services/css/package.json` or publish a new components version.

---

## 4. Update lockfiles and install

At the repo root:

```bash
cd /home/elf-pavlik/code/solid/sai-js
npm install
```

This updates `package-lock.json` and installs the fork. Do **not** run `npm ci` before the lockfile is updated; `npm ci` requires package.json and the lock to agree.

Verify:

```bash
node -p "require('@solid/community-server/package.json').version"
npm ls @solid/community-server
ls node_modules/@solid/community-server/config/lws.json
```

You want **one** CSS version and the LWS configs present. If `npm ls` shows a nested alpha.2, something still depends on it. The usual suspects are `services/css` (published components rc.29) and any package that pins alpha.2. Add a root `overrides` entry if needed:

```json
"overrides": {
  "@solid/community-server": "github:hackers4peace/CommunitySolidServer#lws-next-major",
  "@solid/access-token-verifier": "github:elf-pavlik/access-token-verifier#6640d34d4446a3b2c1c5d94cefca019f53332b15"
}
```

The override string must match the direct dependency spec exactly.

If you use `services/css` standalone:

```bash
cd services/css
npm install
npm ls @solid/community-server
```

The root docker-compose stack runs `/sai/node_modules/@solid/community-server/bin/server.js`, so the root install is what matters for the stack.

---

## 5. Rebuild the SAI components

`packages/components` compiles against the installed CSS types and generates Components.js metadata:

```bash
cd /home/elf-pavlik/code/solid/sai-js
npm run build --workspace @elfpavlik/sai-components
# or: cd packages/components && npm run build
```

Then typecheck:

```bash
npm run typecheck
```

---

## 6. Quick verification

```bash
cd /home/elf-pavlik/code/solid/sai-js

# version and LWS configs
node -p "require('@solid/community-server/package.json').version"
ls node_modules/@solid/community-server/config/solid-lws.json

# boot the stock LWS preset
node node_modules/@solid/community-server/bin/server.js \
  -c node_modules/@solid/community-server/config/solid-lws.json \
  -f /tmp/css-lws-data -b http://localhost:3456/ -p 3456
```

For the real stack, use the SAI configs after the config changes from `first-look.md`:

```bash
node node_modules/@solid/community-server/bin/server.js \
  -c environments/css/data.json \
  -f /tmp/sai-data -b http://localhost:3457/ -p 3457
```

---

## 7. Active CSS development with `npm link`

Use this when you are editing CSS and `sai-js` at the same time. It avoids repacking/reinstalling on every CSS change.

```bash
cd ~/code/solid/CommunitySolidServer
npm ci
npm run build
npm link

cd ~/code/solid/sai-js
npm link @solid/community-server
```

Now `sai-js/node_modules/@solid/community-server` is a symlink to the fork. After editing CSS:

```bash
cd ~/code/solid/CommunitySolidServer
npm run build
```

The server and Components.js read `dist/` and `config/`, so a rebuild is required after TypeScript changes. Config-only JSON changes need no rebuild.

Caveats:

- `npm install` / `npm ci` in `sai-js` may replace the link; re-run `npm link @solid/community-server`.
- `npm link` does not run the fork's `prepare`; build manually.
- If `packages/components` has its own nested `node_modules`, link there too, or rely on the root hoist.
- For docker/dagger, switch back to the git URL or a tarball; the link is host-local.

---

## 8. Docker / dagger

- **docker-compose** mounts the repo at `/sai` and runs `/sai/node_modules/@solid/community-server/bin/server.js`. A git dependency works. A host-only `npm link` or sibling `file:` path does not exist inside the container.
- **dagger** runs `npm ci` in the source context. A sibling `file:` path is outside the context. Use the git URL with a commit SHA, or put a tarball inside the repo and use `file:vendor/...tgz`.
- Verify inside the container:

```bash
docker compose exec auth node -p \
  "require('/sai/node_modules/@solid/community-server/package.json').version"
```

- The test workspace (`test/`) uses the root `node_modules`; no separate CSS dependency.

---

## 9. Syncing the fork

```bash
cd ~/code/solid/CommunitySolidServer
git fetch upstream versions/next-major
git merge upstream/versions/next-major
# or rebase the LWS commits on top
git push
```

If you use a branch spec, `npm update @solid/community-server` in `sai-js` refreshes the lock to the new branch head. If you pin a commit SHA, change the SHA explicitly. For CI, pin a commit.

---

## 10. Git dependency build caveats

A GitHub dependency runs the package's `prepare` script on install. CSS's `prepare` is `npm run build` (`tsc` + `componentsjs-generator`). In a fresh test, `npm install github:jeswr/CommunitySolidServer#feat/lws-next-major` took about **50 seconds**, installed the build devDependencies, and produced `node_modules/@solid/community-server/dist/index.js` and `config/lws.json`. So the basic build-on-install works.

Expect these issues:

- **Build on every clean install.** `npm ci` in Docker/dagger rebuilds CSS from source; npm's cache helps only if it is shared. Budget the time or use a prebuilt tarball.
- **Lifecycle-script policy.** npm 11.19 printed:
  ```text
  npm warn install-scripts 1 package has install scripts not yet covered by allowScripts:
  npm warn install-scripts   @solid/community-server@8.0.0-alpha.3 (prepare: npm run build)
  ```
  In this environment the build still ran. If your npm enforces `allowScripts`, approve it (`npm install-scripts approve @solid/community-server`) or use a prebuilt tarball. A blocked `prepare` leaves no `dist/`.
- **Lockfile uses `git+ssh`.** npm recorded:
  ```text
  "resolved": "git+ssh://git@github.com/jeswr/CommunitySolidServer.git#311b367..."
  ```
  even when the spec was `git+https`. CI/Docker without SSH keys will fail to fetch it. Either add:
  ```bash
  git config --global url."https://github.com/".insteadOf "git@github.com:"
  ```
  or use a prebuilt tarball. The rewrite also works in a Dockerfile/dagger step.
- **`--omit=dev` does not skip the build.** In a fresh test, `npm install --omit=dev` still installed 833 packages and built `dist/`. npm needs the package's devDependencies to run `prepare`.
- **The fork's `package-lock.json` is ignored.** npm resolves the git package's dependencies from its `package.json` ranges, not from the fork's lock. Your parent lock pins the result after install, but the initial resolution can differ from what the fork tested. Pin a commit SHA and commit the parent lock.
- **Version dedupe.** The fork's version is `8.0.0-alpha.3`; bump it to `8.0.0-alpha.3-lws.1` so npm does not treat it as the registry package.
- **Build failure fallback.** If the target environment cannot build CSS (missing git, SSH, toolchain, or blocked scripts), build locally and install a tarball:
  ```bash
  cd CommunitySolidServer
  npm ci && npm run build
  npm pack --pack-destination ../sai-js/vendor
  ```
  Then use `file:vendor/community-solid-server-8.0.0-alpha.3-lws.1.tgz` in the three `package.json` files. The tarball already contains `dist/` and `config/`, so no build-on-install is needed. This is the most reliable option for Docker/dagger.

## 11. Common pitfalls

- **Nested alpha.2**: a package still depends on `8.0.0-alpha.2`. Check `npm ls @solid/community-server`; update `packages/components`, `services/css`, or add `overrides`.
- **Same version as npm**: the fork's version is `8.0.0-alpha.3` by default. Bump it to `8.0.0-alpha.3-lws.1` so npm does not treat it as the registry package.
- **`npm ci` fails after editing package.json**: run `npm install` first to update the lockfile.
- **Git install build failure**: the fork's `prepare` runs `npm run build`. Build locally, then use `npm pack` + `file:` as a fallback.
- **Components.js metadata stale**: after changing CSS classes/configs, rebuild the fork and `packages/components`; `dist/components` is generated.
- **`npm run validate` fails**: the current alpha.3/fork has the Comunica/CSS generated-components “empty term” issue. The server still boots; use startup/integration tests instead.
- **`services/css` standalone**: it has its own lock and `node_modules`; update it separately. The docker-compose stack uses the root install.
