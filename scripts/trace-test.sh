#!/usr/bin/env bash
# Run the diagram trace test (docs/lws-auth.c4) through Dagger with Tempo tracing on.
#
# This is the per-slice continuity gate for docs/plans/lws-auth.md: it is the flow that
# produced trace 1851eea1… in that diagram, so it must stay green after every slice
# (the old single exchange remains the default until the last slice).
#
#   policy-engine.test.ts › protected resources (scope all, modes all) ›
#   protected resource › authenticated request (authorized agent / authorized client) ›
#   can Read
#
# Two traps this wrapper exists for:
#
#  - npm re-shells everything after `--`, so the vitest `-t` pattern has to be wrapped
#    in literal single quotes and its `(`/`)` regex-escaped. Without both, `>` becomes
#    a shell redirect and vitest silently reports "67 skipped" with zero spans.
#  - Tempo's default search window is ~4 s (`query_end_cutoff: 1s` +
#    `search.query_backend_after: 5s` in
#    `environments/dev/tempo/tempo.yaml`), so query it with explicit
#    `start`/`end` (the script prints a ready-made URL).
#
# Usage: scripts/trace-test.sh [-e http://host:4318]
#   TEMPO_ENDPOINT env var is used when -e is omitted.
set -euo pipefail

endpoint="${TEMPO_ENDPOINT:-http://172.16.0.1:4318}"
while [ $# -gt 0 ]; do
  case "$1" in
    -e) endpoint="$2"; shift 2 ;;
    -h | --help) sed -n '2,20p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

# The regex escapes (`\(`, `\)`) are for the literal parentheses in the describe()
# names; the surrounding single quotes are what survives npm's re-shelling.
pattern='protected resources \(scope all, modes all\) > protected resource > authenticated request \(authorized agent / authorized client\) > can Read'

# One `devbox run` (dyer needs `_EXPERIMENTAL_DAGGER_RUNNER_HOST`), no nested shell.
devbox run -- dagger call --tempo-endpoint="$endpoint" test \
  --testFile=policy-engine.test.ts \
  --only="'${pattern}'"

now="$(date +%s)"
echo
echo "Tempo (default search window is ~4 s, so pass start/end explicitly):"
echo "  curl -s \"http://localhost:3200/api/search?start=$((now - 1800))&end=${now}&limit=20\""
