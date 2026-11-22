# ODRL alignment — future improvements

> **Status:** proposal, not implemented. Captures what the ODRL ecosystem
> offers and what SAI could adopt next. The immediate shape change (target-level
> `registeredShapeTree` / `hasDataRegistration`) is tracked in
> [#120](https://github.com/hackers4peace/sai-js/issues/120); related work is
> [#121](https://github.com/hackers4peace/sai-js/issues/121) (merge the
> per-check reads), [#122](https://github.com/hackers4peace/sai-js/issues/122)
> (Inherited targets / `scopeOfGrant`), and
> [#116](https://github.com/hackers4peace/sai-js/issues/116) (admin audit).
> **Last reviewed:** 2026-11-22.

## Current state

- SAI wraps every grant/claim in ODRL 2.2 (`odrl:Agreement`, `odrl:permission`,
  `odrl:target`) under `lws:access`, with a target descriptor
  `{ type, source, owner, storage }` and the SAI scopes
  `AllFromRegistry`, `SelectedFromRegistry`, `Inherited`, `AllFromAgent`.
- Evaluation is a custom per-pod SPARQL engine (`SaiPermissionsEngine`): it
  matches target/scope/identity by hand and unions the modes of matching
  grants. There is no prohibition, duty, constraint, compliance report, or
  conflict-resolution step.
- Requests carry the SAI need extensions (`accessNeedGroup`,
  `inheritsFromNeed`, `registeredShapeTree`) plus a target; plain LWS ODRL
  requests are accepted on the owner endpoint and resolved against the
  registry.
- The current LWS spec uses a `{ type, value }` target
  (`lws10-core/lws-access-requests.html`); the open
  [w3c/lws-protocol#303](https://github.com/w3c/lws-protocol/issues/303)
  proposes moving the Access Profile to ODRL-style `permission` /
  `target { type, source }`, which is the direction SAI already implements.

## Ecosystem inventory

| Project | License / version | What it gives us | Reuse |
| --- | --- | --- | --- |
| [odrl-force/ODRL-Evaluator](https://github.com/odrl-force/ODRL-Evaluator) | MIT, npm `odrl-evaluator@0.6.0` | Policy + Request + state-of-the-world → compliance report; N3/EYE (`eyereasoner`) | **Test oracle**, not runtime |
| [odrl-force/ODRL-Compliance-Report-Model](https://github.com/odrl-force/ODRL-Compliance-Report-Model) | CC-BY-SA-4.0 model, examples | `PolicyReport` / `RuleReport` / `TargetReport` / `PartyReport` / `ActionReport` / `ConstraintReport`, activation/attempt/performance/deontic states | **Output vocabulary** for `getPermissionsWithReport` |
| [odrl-force/odrl-validator](https://github.com/odrl-force/odrl-validator) | MIT, npm `odrl-validator@0.2.0` | SHACL validation of ODRL 2.2 + deontic conflict detection | **CI gate** on grants/claims, with a SAI profile |
| [odrl-force/FORCE](https://github.com/odrl-force/FORCE) | spec | Umbrella spec, terminology, ODRL 3.0 proposals | Reference |
| [odrl-force/ODRL-Test-Suite](https://github.com/odrl-force/ODRL-Test-Suite) | test data | 70+ policy/request/SotW/report cases, incl. AssetCollection membership (`testcase-053`) | Test matrix inspiration |
| [odrl-force/ODRL-Test-Utils](https://github.com/odrl-force/ODRL-Test-Utils) | — | Test-case generation utilities | Test generation |
| [SolidLabResearch/ODRL-Test-Conflicts](https://github.com/SolidLabResearch/ODRL-Test-Conflicts) | test data | Conflict, ambiguous, underspecified cases | Conflict matrix |
| [SolidLabResearch/ODRL-atomizer](https://github.com/SolidLabResearch/ODRL-atomizer) | ISC, npm `odrl-atomizer@0.1.2` | Rule composition / atomization | Normalization |
| [odrl-force/ODRL-Atomization](https://github.com/odrl-force/ODRL-Atomization) | MIT, npm `odrl-atomization@1.0.4` | Same, newer, used by `odrl-validator` | Normalization |
| [SolidLabResearch/ODRL-instantiation](https://github.com/SolidLabResearch/ODRL-instantiation) | prototype, no license file | Policies + request + SotW → `odrl:Agreement`; copies request target; `dcterms:references` to request/policies | **Pattern**, not dependency |
| [jvherweg/policy-conflict-resolver](https://github.com/jvherweg/policy-conflict-resolver) | MIT, `0.0.3`; repo redirects to `joachimvh/policy-conflict-resolver` | `ConflictEvaluator` = `PolicyExtractor` + ODRL evaluator + `ConflictResolver`; active-only / priority / deny-overrides; Components.js module | **Pattern / optional module** |
| [SolidLabResearch/user-managed-access](https://github.com/SolidLabResearch/user-managed-access) | — | `OdrlAuthorizer`: Permission query → ODRL Request → evaluator → reports → permissions; UMA contract instantiation | Pattern |
| [SolidLabResearch/loama](https://github.com/SolidLabResearch/loama) (`feat/odrl`) | — | Solid app policy CRUD + access requests against an authorization server | Pattern |
| [w3c/lws-protocol#303](https://github.com/w3c/lws-protocol/issues/303) | open issue | Align LWS Access Profile with ODRL 2.2 (`permission`, `type`/`source` targets) | Spec anchor |

## 1. Target profile hardening (landed, #120)

Landed as an atomic cutover (no dual-read):

- `interop:registeredShapeTree` and `interop:hasDataRegistration` live on the
  ODRL target; the policy-level `registeredShapeTree` and the selected-target
  `odrl:partOf` are gone from grants, claims and SAI need requests.
- `AllFromAgent` keeps a target-level shape tree and storage but has no
  registration; selected **requests** carry an advisory
  `interop:hasDataRegistration`, while grants/claims require it.
- Registration targets use `odrl:source` as the registration; `hasDataRegistration`
  is only on `odrl:Asset` targets. A shape-tree need names it as `source` and
  omits the redundant `registeredShapeTree`.
- `odrl:partOf` remains only on the external plain-LWS request boundary.
- `SaiAuthorizationManager.getParent` is a `return undefined` stub (required by
  the policy-engine interface); the engine resolves parents from `lws:partOf`
  metadata only and denies when it is missing.

Still open: the small SAI SHACL profile and the validator gate (§2).

## 2. ODRL validator gate

Use `odrl-validator` on every serialized grant and claim in tests/CI:

- `odrl-validator` checks: one target/assignee/assigner per rule, target is
  `Asset`/`AssetCollection`, `AssetCollection` has at most one `source`,
  `Asset.partOf` points to an `AssetCollection`, profile actions require
  `odrl:profile`, compound-rule expansion.
- It does **not** know `interop:registeredShapeTree`,
  `interop:hasDataRegistration`, or the SAI action set; add a thin SAI profile
  shape file (target-level shape tree, selected-target registration,
  `partOf` forbidden on data targets) and run both.
- Known gaps worth encoding as our own assertions: the validator's policy
  extractor assumes `odrl:action`/`odrl:target` live on the rule, and it does
  not detect custom profile relations as rule boundaries. Our selected grants
  already emit one permission per instance, so the cross-product case is
  limited.

## 3. ODRL evaluator conformance oracle (tests only)

`odrl-evaluator` evaluates `policy + request + state-of-the-world`; it is not a
drop-in for the storage hot path (EYE/`eyereasoner`, normalized ODRL input, no
registry/storage model). Use it as an independent oracle:

- Build an `odrl:Request` permission per check:
  `[assignee, action, target]`; add `temp:currentTime` to the SotW.
- For registration/collection scopes, add
  `<instance> odrl:partOf <registration>` to the SotW (the exact shape of
  `ODRL-Test-Suite/data/sotw/assetMembership.ttl` and `testcase-053`).
- Compare the evaluator's active permission report with
  `SaiPermissionsEngine.getPermissions` for the AllFromRegistry / Selected /
  Inherited matrix. Keep it in `test/` or a dev-only workspace.
- This is also the cheapest way to document the SAI ↔ ODRL mapping for
  external evaluators.

## 4. Compliance reports and “why denied”

`SaiPermissionsEngine.getPermissionsWithReport()` currently throws. Model its
output on the FORCE vocabulary:

- `PolicyReport` → `RuleReport` (`PermissionReport` / future
  `ProhibitionReport`) → `TargetReport` / `PartyReport` / `ActionReport` /
  `ConstraintReport`.
- Use the FORCE states (`Satisfied`, `Active`, `Attempted`, `Fulfilled`,
  `Violated`, …) so a denial says *which* premise failed: target shape tree,
  registration, owner, storage, identity, scope, action.
- Reuse for #116 (admin-impersonation audit) and for debugging the claim
  matrix; eventually expose it behind the policy-engine `PermissionReport`
  interface.

## 5. Conflict resolution

SAI currently unions permissions across matching grants and claims. There is
no prohibition, duty, priority, or deny-override. `policy-conflict-resolver`
shows a clean decomposition we can copy or plug in:

- `ConflictEvaluator(extractor, evaluatorHandler, resolver)` — extract one
  policy/rule combination at a time, evaluate each, then combine reports.
- `PolicyExtractor` / `OdrlPolicyExtractor` — split a policy by
  `odrl:action` × `odrl:target` into atomic rules; useful if external grants
  arrive with multi-target rules.
- Resolvers:
  - `ActiveConflictResolver` — keep only `report:Active` rules;
  - `PriorityConflictResolver` — keep the highest
    `urn:example:custom:odrl:priority` (or default `0`); missing priorities
    fall through unless configured otherwise;
  - `DenyConflictResolver` — prohibition wins; no rule → deny (fail-closed).
- Output: `ConflictReport` with `algorithm` (`OnlyActiveRules`,
  `HighestPriority`, `PrioritizeDeny`), `conclusion` (`Allow`/`Deny`),
  `reason`, `policyReport`, plus the embedded policy reports.
- The library is also a Components.js module (`lsd:module`, `config/`), so it
  can be plugged into a CSS-based deployment if the policy engine ever moves
  there.

What SAI would need first:

- Define SAI conflict semantics. Today “most specific grant wins” is only used
  for choosing a claim edge (`DelegatedAccessClaimValidator`), not for
  evaluation. A natural mapping is `scopeOfGrant` rank
  (`Selected > Inherited > AllFromRegistry > AllFromAgent`) or an explicit
  `odrl:priority` / `urn:sai:priority` on grants.
- If prohibitions/duties are ever added to grants/claims, `DenyConflictResolver`
  and the compliance-report states are the right starting point.
- Don't reuse the extractor blindly: it does not recognize custom profile
  relations (e.g. our target-level shape tree/registration) as rule parts.

## 6. Atomization and normalization

- Ensure every signed claim has one assignee, assigner, action and target per
  rule (ODRL validation normalization N5). Our `grantAccess` already emits one
  permission per instance; a multi-action permission is still valid ODRL but
  harder to evaluate/report.
- `odrl-atomization` (MIT, `1.0.4`) is the maintained package used by
  `odrl-validator`; `odrl-atomizer` (ISC, `0.1.2`) is the older one used by
  `odrl-evaluator`. Pick one if we normalize external grants.
- Run the normalizer in tests over every generated grant/claim, or at mint
  time if we ingest externally-produced ODRL.

## 7. Instantiation pattern (request/need → grant/claim)

`ODRL-instantiation` and the UMA `ContractManager` show the pattern:

- Take the request/need target descriptor and **copy it** into the agreement
  rule — do not re-derive target metadata from policy-level fields.
- Set `assigner` / `assignee` from the request (or the delegation edge).
- Add `dcterms:references` from the agreement/grant to the request and the
  source policies.
- Generate fresh rule/target ids per action/target; keep the request id stable.
- Check the resulting agreement against the source policies before persisting.

This is the design argument for target-level
`registeredShapeTree` / `hasDataRegistration`: the need already knows both, and
the grant/claim should carry them unchanged.

## 8. LWS #303 and the future LWS ODRL profile

- Follow [w3c/lws-protocol#303](https://github.com/w3c/lws-protocol/issues/303):
  the current LWS Access Profile uses `{ type, value }` targets; the proposal
  moves to ODRL-style `permission` + `target { type, source }` (what SAI
  already writes).
- When the LWS ODRL profile is published, declare its IRI as `odrl:profile`
  (we currently use `interop:AccessProfile`) and align the action set
  (`lws:create` is an LWS/profile action, not core ODRL).
- Keep an adapter for the **current** CSS LWS reader (which expects
  `target.type = DataResource | Container | StorageResource` and
  `target.value = [...]`). Do not migrate SAI grants back to `value`; translate
  at the boundary if a storage speaks only the current shape.
- `odrl:partOf` stays meaningful only in the request/SotW direction; the SAI
  wire uses `interop:hasDataRegistration`.

## 9. Constraints

- The LWS profile supports `client`, `purpose`, `format`, `type`, `dateTime`
  left operands (`AccessGrantUtil.LEFT_OPERANDS`). SAI currently matches
  agent/client identity structurally and has no constraint evaluation.
- Candidate constraints for SAI claims: `client` (bind a claim to a client),
  `dateTime` (expiry), `purpose` (usage control). `odrl-validator` already has
  SHACL rules for operator compatibility; `ODRL-Evaluator` implements temporal
  and purpose constraints.
- Do not mix this with the target metadata decision: constraints are a
  separate ODRL mechanism; the shape tree/registration stay target properties.

## 10. Test data reuse

- Port the `ODRL-Test-Suite` AssetCollection/PartyCollection cases into the
  claim matrix; `testcase-053` is the canonical
  `<instance> odrl:partOf <collection>` pattern.
- Use `ODRL-Test-Conflicts` cases when prohibitions/duties/priority land.
- `ODRL-Test-Utils` can generate policy/request/SotW triples for the oracle
  test; avoid hand-writing another fixture family.

## 11. External interop adapter

- A small adapter should translate:
  - SAI grant/claim → ODRL `Request` + SotW for `odrl-evaluator`;
  - SAI target descriptor → current CSS LWS `{ type, value }` grants (for
    storages that only implement the current LWS reader);
  - externally-produced ODRL `Set`/`Agreement` → SAI `GrantData` (target
    descriptor, scopes, shape tree/registration).
- Keep it out of the hot path; use it in conformance tests and at federation
  boundaries.

## Non-goals

- Replacing `SaiPermissionsEngine` with `odrl-evaluator` at request time.
- Adopting UMA ticket architecture or the loama/controller model.
- Expressing shape tree/registration as core ODRL terms; they are SAI profile
  metadata.
- A dual-read compatibility window for old grants/tokens (see the pinned
  no-compatibility decision in `docs/plans/id-jag.md` history).

## Dependency notes

| Package | Version | License | Notes |
| --- | --- | --- | --- |
| `odrl-evaluator` | 0.6.0 | MIT | pulls `eyereasoner`, `eyeling`, `rdf-isomorphic`, `rdf-lens`, `odrl-atomizer`; test-only for us |
| `odrl-validator` | 0.2.0 | MIT | SHACL + conflict detection; `n3` 2, `rdf-validate-shacl`, `shacl-engine` |
| `odrl-atomization` | 1.0.4 | MIT | used by `odrl-validator` |
| `odrl-atomizer` | 0.1.2 | ISC | older; used by `odrl-evaluator` |
| `policy-conflict-resolver` | 0.0.3 | MIT | Node >=18; Components.js module; depends on `odrl-evaluator` only in dev |

## References

- ODRL 2.2 model: <https://www.w3.org/TR/odrl-model/>
- ODRL 2.2 vocabulary: <https://www.w3.org/TR/odrl-vocab/>
- ODRL formal semantics: <https://w3c.github.io/odrl/formal-semantics/>
- FORCE: <https://w3id.org/force>
- LWS core access profile:
  <https://w3c.github.io/lws-protocol/lws10-core/#access-profile>
- LWS #303: <https://github.com/w3c/lws-protocol/issues/303>
- ODRL-Evaluator support matrix:
  <https://github.com/odrl-force/ODRL-Evaluator/blob/main/ODRL-Support.md>
- ODRL validator requirements:
  <https://github.com/odrl-force/odrl-validator/blob/main/docs/Requirements.md>
