# Authorization revocation — UI revokes an authorization, a workflow revokes the grants

> **Status: design only — deferred.** Extracted from the activity-first design
> (now documented in the OpenWiki `services/activity-lifecycle.md` and
> `services/rpc-and-services.md`), step 4 (the `revokeGrants` leg, re-framed
> 2026-09): the grant-revocation *temporal* artifacts dormant in that step
> are **retired** by the activity-first cleanup — this plan captures the
> authorization-revocation leg itself, to be worked later.
> Builds on [`authorization-revoked.md`](authorization-revoked.md) (the typed
> `authorizationRevoked` producer — routed today, only the producer missing)
> and [`revoke-delegation-chain.md`](revoke-delegation-chain.md) (the
> revocation operation at the delegation issuance boundary).
> **Decision (2026-09):** this plan is the **designated home of the revoke
> action** — [`authorization-granting.md`](authorization-granting.md) §9
> Step 4 defers all withdrawal work here (no `AuthorizationRevoked` producer
> lands in the granting plan; `granted:false` becomes a pure decline).

## 1. The invariant

**Grants are revoked only (a) via the issuance endpoint and (b) from
workflows — never directly from the UI.** The UI revokes an **authorization**;
a workflow revokes the grants as a derived consequence.

- (a) **Issuance endpoint** — `GrantRevocationHandler` (the AccessRevocation
  POST boundary, live: the `revoke-delegation-chain.md` first-cut slice) —
  direct HTTP revocation.
- (b) **Workflows** — role membership change / role deletion (the activity-first
  derived regeneration — registration links cleared, grant resources left as
  orphans; see the OpenWiki `services/activity-lifecycle.md`), and this plan's
  authorization-revocation leg.

## 2. The leg

1. **UI revoke targets the authorization** (the granted DataAuthorizations in
   the authorization view) — the RPC keeps validation reads and writes
   `authorizationRevoked` as the **typed producer** (per
   `authorization-revoked.md`: the handler, the per-grantee consumer and the
   reconciliation sweep already route it; only the producer is missing).
2. **The workflow performs the grant revocation** as a derived operation, with
   the **org session** (`getSession(ctx.webId)` — fixes the seeded-ACR 403
   debt the admin's UAS hits on seeded grant closures):
   - delete the DataAuthorizations (the per-grantee consumer / a dedicated
     revoke workflow);
   - revoke the derived grants **at the issuance boundary** (the requester
     hop: POST AccessRevocation to the data owner) and/or locally with the
     org session;
   - clear the grantor's projection (`hasDataGrant` links).
3. **`authorizationRevoked`'s carrier** — the `Revoked` re-pin (real-id
   embedded / live-link object form, `target` dropped) lands with
   [`authorization-granting.md`](authorization-granting.md) (the extracted
   granting pair — the `AuthorizationRecorded`/`Revoked` re-pins) per the
   activity-first contract snapshot now documented in the OpenWiki
   `services/activity-lifecycle.md`; this leg consumes that shape.

## 3. Open decisions

1. **Revocation orchestrator** — reuse the (currently retired)
   `processGrantsRevocation` requester-hop shape, revived for this leg, vs a
   dedicated local-revoke workflow. If reused, the dormant temporal wiring
   retired by the activity-first cleanup is re-landed here — deliberately, with
   a producer.
2. **`grantsRevoked` observability** — the delegation-chain follow-up's
   "grantor trigger integration (`grantsRevoked` producer)" item
   (`revoke-delegation-chain-follow-ups.md` item 4) rides this plan — either
   as this leg's produce, or stays producer-less with the reconciliation
   sweep as the only backstop.

## 4. Out of scope here

- The **dormant temporal grant-revocation artifacts** (`grantsRevoked`
  activity class + api-messages projection + handler/reconcile branches +
  `processGrantsRevocation` + `requestGrantRevocation` /
  `removeDataGrantsFromRegistration` activities + the `events.ts`/openwiki/services/activity-lifecycle.md
  rows) are **retired by the activity-first cleanup** — this plan revives
  only what the leg needs, under decision 1.
- The **issuance endpoint** itself stays exactly as landed
  (`revoke-delegation-chain.md`).