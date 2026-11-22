# Test utilities

Shared seeding and test helpers for `sai-js`:

- `fuseki.ts` — split a TriG fixture per pod dataset and write each dataset to Fuseki.
- `garage.ts` — provision one Garage bucket and key per data pod.
- `postgres.ts` — seed and inspect the CommunitySolidServer key-value table.
- `env.ts` — drop and seed a Fuseki dataset.

These helpers are used by the Dagger-driven suite under `/test`, by the
`packages/repl` seed test, and by `packages/repl`'s `seed-env` command for the
local Docker environment.

Unit tests under `packages/*/test` should use local mocks. The full
`environments/data/registry.trig` fixture is reserved for the `/test`
integration suite and the local dev seed command.
