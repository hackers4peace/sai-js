# Garage (dev/dagger)

Single-node Garage v2 used by the compose and dagger environments. `garage.toml`
holds the config, including the admin token the worker uses to provision buckets.

Only the node identity and the applied cluster layout are committed:

- `meta/node_key`, `meta/node_key.pub` — the node's identity; it must stay in
  sync with the node id baked into `cluster_layout`
- `meta/cluster_layout` — the applied layout (zone `dc1`, 1 GB capacity), so the
  node is usable immediately (`garage layout assign`/`apply` need not be run)

Everything else is regenerated on start and git-ignored: `meta/db.sqlite*`,
`meta/data_layout`, `meta/peer_list`, `meta/scrub_info`,
`meta/lifecycle_worker_state`, and the whole `data/` object store (the
`data/garage-marker` is derived from `data_layout`).

There are **no committed buckets, keys or objects** — the seed provisions one
bucket + key per data pod at run time
(`packages/test-utils/src/garage.ts#seedObjectEndpoints`).
