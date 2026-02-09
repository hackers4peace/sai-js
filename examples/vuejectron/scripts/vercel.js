import { mkdirSync, writeFileSync } from 'node:fs'

mkdirSync('public', { recursive: true })

writeFileSync('public/id.jsonld', process.env.CLIENT_ID)
writeFileSync('public/config.json', process.env.CONFIG)
