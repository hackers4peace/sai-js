# Plan conventions

These conventions apply to every file in `docs/plans/`. They exist because the
plans are worked on across many agent sessions: a session must be able to
establish ground truth, pick a capability, and leave the repo green without
re-deriving the whole design or trusting a stale status line.

## 1. Status vocabulary

| Marker | Meaning |
|---|---|
| 🔶 in progress | designed and partly landed; open capabilities remain |
| ⬜ not started | designed (or design-only) and not yet implemented |
| 📝 design note | a decision/investigation, not a shippable plan |
| 🧭 umbrella | indexes a workstream; not itself shippable |
| ✅ done | removed from this directory; the landed design lives in the OpenWiki |

A plan's own `Status` header is the primary source. The index is a snapshot and
must be updated when a status changes.

## 2. Required header

Every plan starts with:

```md
> **Status:** <marker + one sentence>
> **Last verified:** `<commit>` (<date>) — what was checked
> **Green gate:** <commands + `/test` acceptance, or a link to the section>
> **Workstream:** <link to the home plan, if this is a slice detail>
```

`Last verified` is a claim about the **code**, not about the document. A session
that discovers drift fixes it in the same session.

## 3. Ground-truth rule

No **"landed"** claim without:

1. a code anchor (`path:symbol` or `path:line`), and
2. a named test that proves the behavior.

If either is missing, the item is **partial** or **open**. Prose that describes
a design is not evidence that the design is implemented.

When absorbed material is deleted, leave a short note in the surviving plan
(`Absorbs: former <file>`) so future sessions can find the history in git.

## 4. State map

Every workstream plan has a state map as the first substantive section:

| Capability / primitive | Status | Code anchors | Verified by | Notes |
|---|---|---|---|---|

- One row per capability or shared primitive, not per file.
- Status is `✅ landed`, `🔶 partial`, or `⬜ open`.
- `Verified by` names the package test or `/test` file. Root `/test` suites are
  user-run (see §7), so a row proven only by `/test` is still acceptable — mark
  it `landed (acceptance user-run)`.

## 5. Capability slices

Slices are **user-visible capabilities**, not implementation layers. Each slice
has:

```md
### C<n> — <capability>

**Done when:** <observable behavior, end to end>
**Depends on:** <slice ids + external code>
**Green gate:** <commands>
**`/test` acceptance:** <files/tests — user-run>
**Touchpoints:** <files/symbols>
**Notes:** <decisions, hazards, what is deliberately out of scope>
```

Rules:

- **Do not split a primitive from its first caller.** A shared helper (`request
  revocations`, chain predicate, reconciliation) lands with the capability that
  first uses it.
- **Coordinated breaks land together** (schema + producer + consumer + tests).
- Legitimate checkpoints inside a slice are fine; they are not separate slices.
  Do not invent a "types only" or "wire the flag" milestone.
- A slice is **not** `landed` until the `/test` acceptance has been run by the
  user (see §7). Package tests proving the unit behavior are not a substitute.

## 6. Decision log

- Decisions are numbered `D1..Dn` and never deleted silently.
- A superseded decision keeps its number and gets
  `**Superseded by:** D<n>` plus one sentence.
- New sessions append; they do not rewrite history to look consistent.
- Each decision states the **recommendation** and the **status**
  (`pinned`, `open`, `superseded`). "Decide later" is acceptable only with the
  question and the options written down.

## 7. Green gates and the `/test` boundary

An agent may run, from the repo root:

```bash
npm run typecheck
npx tsc -p packages/components/tsconfig.json --noEmit
npx vitest run --project @janeirodigital/interop-authorization-agent
npx vitest run --project @elfpavlik/sai-components
```

- `npm test` runs the turbo `test` scripts. `packages/components` has no `test`
  script, so **use the `npx vitest --project` form** for its suite.
- Package tests are the agent-runnable gate; they use SPARQL mocks / mocked
  Temporal and need no external services.
- `/test` is the dagger-driven integration suite. **Only the user runs it**
  (the repo-root `.dagger` environment; data comes from
  `/environments/data`). The agent adds or updates the test files in the same
  change set and marks the slice `landed (acceptance user-run)` until the user
  confirms.
- Baseline at `d7c89f43`: typecheck green; components suite 24 files / 184
  tests (~4 s); authorization-agent suite 17 files / 111 passed, 20 skipped
  (~2 s).

## 8. Index membership

Every `.md` in this directory appears in `index.md`, except `index.md` and this
file. Every markdown link in a plan resolves to an existing file (or an
external URL). If a plan is absorbed, its row is removed and the surviving plan
is linked instead. A small `plans:check` script is a possible future guard; until
then, check links when touching the index.

## 9. Session protocol

**Start**

1. Read the workstream's state map and the slice you intend to work on.
2. Re-verify the anchors (`rg`/`git log`) and run the slice's package gate. Do
   not build on a `landed` claim you have not verified.
3. If the plan and the code disagree, fix the plan first (in the same change
   set) so the next session does not inherit the drift.

**Execute**

1. Implement the whole capability, including its first caller, tests, and any
   coordinated break.
2. Keep `/test` changes in the same change set; mark them as user-run
   acceptance.
3. Do not leave a half-wired feature behind a flag or a "next step" comment
   unless the plan explicitly defines the intermediate state as safe and
   green.

**End**

1. Run the package gate + typecheck.
2. Update the state map: `landed` / `partial` / `open`, with anchors and tests.
3. Move discovered work into the slice table or the decision log. Do not leave
   it in prose.
4. Update `index.md` if a status or the file set changed.
