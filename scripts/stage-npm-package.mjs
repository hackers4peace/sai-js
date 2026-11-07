#!/usr/bin/env node
// Stage a workspace package for npm: copy the files that should ship and point
// the published manifest at the build output. Local development keeps using the
// TypeScript source entrypoints in the repository.
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const [sourceArg, targetArg] = process.argv.slice(2)
if (!sourceArg || !targetArg) {
  console.error('usage: stage-npm-package.mjs <package-dir> <staging-dir>')
  process.exit(1)
}

const source = resolve(sourceArg)
const target = resolve(targetArg)
const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))

const entrypoints = [
  manifest.main,
  manifest.types,
  ...Object.values(manifest.exports ?? {}).flatMap((entry) =>
    typeof entry === 'string' ? [entry] : Object.values(entry ?? {})
  ),
]
const sourceEntrypoints = entrypoints.some(
  (entry) => typeof entry === 'string' && entry.startsWith('./src/')
)

if (sourceEntrypoints) {
  manifest.main = './dist/index.js'
  manifest.types = './dist/index.d.ts'
  manifest.exports = {
    '.': {
      types: './dist/index.d.ts',
      default: './dist/index.js',
    },
  }
  manifest.files = ['dist/']
}

// The staged package is already built; its publish lifecycle scripts and
// development dependencies do not belong in the tarball.
delete manifest.scripts
delete manifest.devDependencies

// npm always includes these when present, but they must exist in the staging
// directory first.
const files = new Set(manifest.files ?? [])
for (const name of ['README.md', 'LICENSE', 'LICENCE']) {
  if (existsSync(join(source, name))) files.add(name)
}

mkdirSync(target, { recursive: true })
for (const file of files) {
  const relative = file.replace(/\/$/, '')
  const from = join(source, relative)
  if (!existsSync(from)) {
    console.warn(`skip missing publish file: ${relative}`)
    continue
  }
  cpSync(from, join(target, relative), { recursive: true })
}

writeFileSync(join(target, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
