import { readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import jsonld from 'jsonld'
import { Parser, Writer } from 'n3'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = join(__dirname, 'public')

async function turtleToNQuads(turtleText) {
  const parser = new Parser({ format: 'text/turtle' })
  const quads = parser.parse(turtleText)
  const writer = new Writer({ format: 'N-Quads' })
  return new Promise((resolve, reject) => {
    for (const q of quads) {
      writer.addQuad(q)
    }
    writer.end((error, result) => {
      if (error) {
        reject(error)
      } else {
        resolve(result)
      }
    })
  })
}

async function convertFile(filePath) {
  const turtleText = await readFile(filePath, 'utf8')
  const nquads = await turtleToNQuads(turtleText)
  const doc = await jsonld.fromRDF(nquads, { format: 'application/n-quads' })
  const jsonldFile = `${join(dirname(filePath), basename(filePath, extname(filePath)))}.jsonld`
  await writeFile(jsonldFile, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
  console.log(`✔ ${basename(filePath)} -> ${basename(jsonldFile)}`)
}

async function main() {
  const publicDir = join(PUBLIC_DIR, 'trees')
  const entries = await readdir(publicDir)
  const ttlFiles = entries.filter((f) => f.endsWith('.ttl'))
  for (const f of ttlFiles) {
    await convertFile(join(publicDir, f))
  }
  console.log(`Done. Converted ${ttlFiles.length} file(s).`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
