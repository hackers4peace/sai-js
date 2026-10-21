# Files

- [Sequence and discovery flows](sequence-views.md) - A catalogue of the dynamic views in docs/temporal.c4 — discovery, reciprocal registration, invitation, admin, roles, share/request access, and authorization flows — plus the LikeC4 authoring conventions used to keep them consistent.
- [Temporal workflows and activities](workflows.md) - The Temporal client and worker bootstrap, the four task queues (create-grants, reciprocal-registration, forward-to-push, webhook-delivery), the typed *Id boundary objects, the self-contained createGrantsForAgent regeneration, findRoleUsage routing, the single-activity share with per-grantee fan-out, and how activities call back into the service layer.
