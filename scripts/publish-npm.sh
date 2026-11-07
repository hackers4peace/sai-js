#!/usr/bin/env bash
# Publish the package in the current directory if the version is not on npm yet.
#
# Run through Turborepo; the `publish:npm` task depends on the same task in
# workspace dependencies, so packages are published in dependency order.
set -euo pipefail

package="$(node -p "require('./package.json').name")"
version="$(node -p "require('./package.json').version")"
tag="${NPM_TAG:-rc}"

if npm view "${package}@${version}" version >/dev/null 2>&1; then
  echo "skip ${package}@${version}: already published"
  exit 0
fi

# Build only when publishing; local development and tests use src/ directly.
if node -e "process.exit(require('./package.json').scripts?.prepublishOnly ? 0 : 1)"; then
  npm run prepublishOnly
fi

stage="$(mktemp -d)"
trap 'rm -rf "${stage}"' EXIT
node ../../scripts/stage-npm-package.mjs "$PWD" "${stage}"

echo "publish ${package}@${version} (dist-tag ${tag})"
npm publish "${stage}" --access public --tag "${tag}" --ignore-scripts
