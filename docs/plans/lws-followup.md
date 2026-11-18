# LWS alignment follow-ups

> **Status:** ⚙️ open backlog — **4 of 15** items closed or obsolete since
> 2026-11-13; the rest are listed below by what they need next.
> **Last verified:** working tree (2026-11-18) — C0–C7 landed (`id-jag.md`);
> package gate (`typecheck`, `check`, `vitest` 690 / 26 skipped / 2 todo) and
> the full Dagger `/test` (24 files / 198 tests) green; CSS fork pinned to
> `ed9224991` on `lws-sai` (`package-lock.json`).
> **Green gate:** `npm run typecheck && npm run check && npx vitest run`;
> rebuild `@elfpavlik/sai-components` before Dagger; `/test` is user-run
> ([`id-jag.md` § Green gate](id-jag.md#green-gate)).
> **Workstream:** former `lws/` alignment plan (removed; history in git).
> Absorbs the old `lws/TODO.md`, `lws/lws-alignment-plan.md`, and
> `lws/phase-0-wire-contract.md`.

Since this list was written, four plans reshaped the model it assumed: **C0**
removed `interop:requester`, **C5** narrowed the owner endpoint to need-based
requests, **C6** made storage authorization token-carried (claim / `scope`,
public reader), **C7** replaced the `/.sai/proxy-admin` document proxy with
read-only admin impersonation of the org.

## Open

**Decision needed**

- [ ] `Inherited` grant targets: copy the parent target or keep using the child
      registration? `grantCoversClaim` and claim derivation already handle the
      parent/child relation (`packages/components/src/grant-policy.ts`).
- [ ] Drop `scopeOfGrant` from request/grant envelopes. It is load-bearing —
      `AllFromRegistry` / `SelectedFromRegistry` / `Inherited` ranking in claim
      derivation, `SCOPE_RANK`, 34 files — so this is a design step.

**Code**

- [ ] Optional `storage` in needs requests: `AccessNeedData` names only the
      shape tree and modes (`packages/data-model/src/access-need.ts`).
- [ ] Remove the policy-level `registeredShapeTree` extension and the
      selected-target `partOf` compatibility field
      (`packages/data-model/src/grant.ts`). Both are still what claim
      derivation and `verifyAccessClaim` read.
- [ ] Hierarchical/path identifier strategy: flat storage still mints members as
      UUIDs directly under the storage root.
- [ ] Remove or gate the path-based parent fallback —
      `SaiPermissionsEngine.getRegistrationId` → `SaiAuthorizationManager.getParent`
      → `identifierStrategy.getParentContainer`, which under flat storage returns
      the pod root. **Now reachable from the claim path**
      (`findAccessClaimData`), so this outranks the item below.
- [ ] Merge the four per-check SPARQL reads in `SaiPermissionsEngine`
      (`determineTargetType` + parent + grandparent + registration,
      `SaiPermissionsEngine.ts:497-543`) into one `SELECT ?type ?parent`.

**External, blocked, conditional**

- [ ] Upstream the bundled context fixes to the LWS context PR — `odrl:assignee`
      IRI coercion, target `value` → `lws:value`, top-level `storage`, no
      top-level `@protected`. They live only in
      `packages/utils/src/odrl-id-jag-context.ts`. *(external)*
- [ ] Nix image builds need the CSS git dependency's `dist/`: the deps phase
      runs `npm ci --ignore-scripts` and skips the fork's `prepare`
      (`nix/packages/sai-runtime.nix` carries the NOTE). Needs a prebuilt
      tarball or a separate derivation. *(blocked on packaging)*
- [ ] If the CSS `.lws` access-document path is ever re-enabled, normalize ODRL
      action IRIs in CSS `AccessPolicy.action` / `ACTION_MODES`. Out of the
      active path since C6. *(conditional)*

**Docs**

- [ ] `README.md:14` still says the access-request endpoint handles "needs,
      **delegation, and revocation**" — C5 removed both. One-line fix.

## Closed / obsolete

- [x] **Delegated grants in `/.sai/grants/<owner>`** — C5, as a decision: the
      view shows every grant the owner **assigns**, including delegated ones
      whose `target.owner` is a peer; mirrored/peer-owned grants stay excluded
      by design (`AccessGrantHandler` documents the contract).
- [x] **`requester = dataOwner`** — obsolete: `interop:requester` is gone (C0).
- [x] **Rebuild `examples/vuejectron/dist`** — obsolete: `dist/` is gitignored
      and the compose stack runs `npm run dev`.
- [x] **Re-run `codegen:likec4` after a `.c4` change** — done 2026-11-18
      (`docs/website/public/likec4-webcomponent.js` was from 2026-10-11 while
      `docs/temporal.c4` changed 2026-11-13); the website's `predev`/`prebuild`
      run it, keep the tracked copy in sync when committing a `.c4` change.

## Operational notes

- Temporal activity names changed during the LWS work (`storeAccessGrant`,
  `deleteAccessGrants`, `replaceAccessGrantsOnRegistration`); in-flight
  workflows from older builds will not resolve them — restart/reseed dev stacks
  after deploying such a build.
- Storage authorization no longer reads grants per request (C6): revocation is
  eventual, bounded by the ID-JAG + access-token TTLs (≈5.5 min at 300 s).
  Public reads stay request-time.
- The Dagger integration suite is green on the pinned CSS fork (`lws-sai` at
  `ed9224991`).
