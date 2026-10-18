# Files

- [Activity outbox and events pipeline](activity-lifecycle.md) - The append-only Activity Registry outbox and its pending/done state machine, the producer and consumer (workflow) tables, the Solid Notifications webhook delivery, ActivityWebhookHandler routing, the ActivityEvents bus, the embedded DataAuthorizationData POJO carrier, and the reconcileActivities backstop.
- [Org-context data plane](org-context.md) - The org-admin data plane with per-pod endpoints — the SPARQL transport abstraction (one query, endpoint chosen by context), the /sparql-admin HTTP-QUERY endpoint with its ?pod ownership gate, the /.sai/proxy-admin GET-only JSON-LD-only proxy, the admin-side peer clients, and the ACP non-cascade constraint.
- [RPC contract and service layer](rpc-and-services.md) - The @effect/rpc contract, the ApiHandler entrypoint, the peer layer diagram, personal-versus-org context resolution (owner identity is the org), and what each component service owns.
