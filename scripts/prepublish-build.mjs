#!/usr/bin/env node
// Build the ESM + declarations output used by the published tarball. Local
// development keeps using src/*.ts, so this only runs when publishing.
import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'

if (process.env.npm_command === 'publish') {
  console.error(
    'Direct `npm publish` would publish src/*.ts. Use `npm run publish:npm` so the package is built and staged from dist/.'
  )
  process.exit(1)
}

rmSync('dist', { recursive: true, force: true })
const tsc = process.platform === 'win32' ? 'tsc.cmd' : 'tsc'
execFileSync(tsc, ['-p', 'tsconfig.build.json'], { stdio: 'inherit' })
