---
name: dagger
description: Run and debug this repository's Dagger integration suite. Use when running /test, reproducing failures, or attaching to the Dagger debugger proxy.
---

# Dagger and the debugger proxy

Run Dagger from Devbox. `devbox.json` sets `_EXPERIMENTAL_DAGGER_RUNNER_HOST`, and a plain shell may not.

## Run the suite

```bash
devbox run -- bash -lc \
  'dagger call --tempo-endpoint=http://172.16.0.1:4318 test'
```

Narrow to files or one test:

```bash
devbox run -- bash -lc \
  'dagger call --tempo-endpoint=http://172.16.0.1:4318 test \
     --testFile="org-context.test.ts roles.test.ts" \
     --only="the authorization and the grants belong to the org"'
```

`--tempo-endpoint=http://172.16.0.1:4318` sends traces to the compose Tempo service. Use the Docker host gateway address because Dagger containers cannot resolve the compose name `tempo`. The full suite takes about 11 minutes. Search the resulting traces with the Tempo MCP tools.

## Playwright report (`ui/authorization/e2e`)

```bash
# run the browser suite and export the HTML report + traces
# (never fails: a red run still exports its report)
devbox run -- bash -lc \
  'dagger call --tempo-endpoint=http://172.16.0.1:4318 playwright-report \
     --grep="vuejectron" export --path=ui/authorization/e2e-out --wipe'
```

`--wipe` is required for a target directory you reuse. `export` MERGES into an
existing host directory by default (same-named files are overwritten, everything
else is kept), so without it `e2e-out/playwright-report/data/` accumulates trace
zips, videos and screenshots from every earlier run, and
`e2e-out/test-results/*/error-context.md` keeps the error pages of long-fixed
failures — easy to mistake for the current run. With `--wipe` the directory ends
up exactly as produced by this run. Export to a fresh path instead if you want to
keep an earlier report:

```bash
dagger call --tempo-endpoint=http://172.16.0.1:4318 playwright-report \
  export --path=/tmp/e2e-out-$(date +%s)
```

## Debugger proxy

Start the proxy:

```bash
devbox run -- bash -lc \
  'dagger call --tempo-endpoint=http://172.16.0.1:4318 proxy-service \
     --test-file=org-context.test.ts up \
     --ports 9240:9240 --ports 19229:9229 --ports 19230:9230 \
     --ports 19231:9231 --ports 19235:9235'
```

The proxy exposes:

| Port | Process  |
| ---- | -------- |
| 9240 | vitest   |
| 9229 | auth     |
| 9230 | registry |
| 9231 | data     |
| 9235 | worker   |

Use the alternate host ports (`19229` and so on) when the dev compose stack already holds the originals.

Read the inspector targets with:

```bash
curl -s http://127.0.0.1:9240/json
```

Open the returned `devtoolsFrontendUrl` with Chrome DevTools or connect with a CDP client. The debug service starts vitest with `--inspect-brk`, so the first pause is before the run. Resume it with `Runtime.runIfWaitingForDebugger`, then `Debugger.resume`. The suite does not start until you do.

Test bodies run in `vitest/dist/workers/forks.js`, which is a separate process from the port 9240 vitest process. To break in test code, temporarily change `test/package.json`:

```json
"dagger:debug": "../node_modules/.bin/vitest run --no-file-parallelism --inspect-brk=0.0.0.0:9240"
```

Then port 9240 targets the worker, not the vitest parent. Revert the script after debugging.

The service processes use `--inspect`, so they are already running. Attach to them, set breakpoints, or send `Debugger.pause` to inspect a stuck handler. This is the fastest way to inspect the auth RPC handler, the registry notification stream handler, and the worker.

Stop the proxy with Ctrl-C or by killing the `dagger call ... proxy-service` process.

## Pitfalls

- **Services run `packages/components/dist`.** The container mounts the host
  worktree as-is, and only `packages/components` has a `build` script — the
  other packages are imported from `src` (Node strips types). After changing
  `packages/*/src`, rebuild before running the suite, otherwise the auth/worker
  services keep serving stale code while the test process sees the new source:
  `npx turbo run build --filter=@elfpavlik/sai-components --force`.
- Run Dagger through `devbox run`. Otherwise the engine host variable is missing.
- `--tempo-endpoint` enables header, token, and body capture. Without it, the suite runs without traces.
- The HTTP capture wrapper clones capturable response bodies. Never treat long-lived stream formats such as `application/x-ndjson` or `text/event-stream` as capturable. The clone waits for the stream to end and blocks the client fetch.
- Dagger services use `node:26-slim`. Do not assume the host Node version matches.
- The proxy starts real auth, registry, data, and worker services. Inspect them before the test timeout kills the failing run.
