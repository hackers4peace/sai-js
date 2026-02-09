import { writeFileSync } from 'node:fs'

writeFileSync('dist/id.jsonld', process.env.CLIENT_ID)
writeFileSync('dist/config.json', process.env.CONFIG)
