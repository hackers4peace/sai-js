# npm publishing (`@hackers4peace`)

> **Status:** 📋 not started — future goal. Replaces the dropped JSR plan;
> extracted from the completed ESM/no-build work (now documented in the OpenWiki
> `architecture/overview.md`). **Not a deployment prerequisite** — see
> [`update-deployment.md`](update-deployment.md).

## Relationship to deployment

Deployment does **not** wait for this plan. `update-deployment.md` ships the
repo TypeScript source under Node 26 (workspace symlinks) so production can run
without published interop tarballs. If this plan lands (built JS artifacts under
`@hackers4peace`), the image build can switch to installing those artifacts and
drop the source-symlink layout; that is a simplification, not a gate.
Publishing is also independent of the storage migration.

## Goal

Publish the packages to npm under the **`@hackers4peace`** org. All packages
move to that scope — `@janeirodigital/interop-utils`, `-data-model`,
`-application`, `-authorization-agent`, `-test-utils`, `sai-api-messages`, and
`@elfpavlik/sai-components` → `@hackers4peace/*`. The old `@janeirodigital` and
`@elfpavlik` scopes are retired.

## Steps

1. Create the `@hackers4peace` npm org + publishing auth (token or OIDC).
2. Rename packages and every cross-package dependency specifier/import.
3. Decide the published artifact: the interop libs are TS-source-only and Node
   cannot strip `.ts` inside `node_modules`, so a publish-time build is needed
   for Node consumers; `components` already builds (`tsc` +
   `componentsjs-generator`).
4. Add a release workflow with `package.json` as the version source of truth.
5. Dry-run (`npm pack`) + a Node consumer smoke test.

## Gate

A dry-run publish produces the expected package set, and a Node consumer can
install and import each package.
