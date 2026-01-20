import { readFileSync } from 'node:fs'
import { createServer } from 'node:https'
import { serve } from '@hono/node-server'
import app from './server.ts'

if (!process.env.CSS_HTTPS_KEY || !process.env.CSS_HTTPS_CERT) throw new Error('env missing!')
serve({
  port: 443,
  fetch: app.fetch,
  createServer: createServer,
  serverOptions: {
    key: readFileSync(process.env.CSS_HTTPS_KEY),
    cert: readFileSync(process.env.CSS_HTTPS_CERT),
  },
})
