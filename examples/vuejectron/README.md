# essentials

## Project setup

```
# yarn
yarn

# npm
npm install

# pnpm
pnpm install
```

### Compiles and hot-reloads for development

```
# yarn
yarn dev

# npm
pnpm run dev

# pnpm
pnpm dev
```

### Compiles and minifies for production

```
# yarn
yarn build

# npm
pnpm run build

# pnpm
pnpm build
```

### Lints and fixes files

```
# yarn
yarn lint

# npm
pnpm run lint

# pnpm
pnpm lint
```

### Customize configuration

See [Configuration Reference](https://vitejs.dev/config/).

## Tracing (optional)

`public/config.json` controls the browser OpenTelemetry SDK per deployment:

```json
"tracing": {
  "enabled": true,
  "otlpBaseUrl": "/otlp",
  "serviceName": "sai-vuejectron",
  "propagateTo": ["^https://[^/]*\\.docker/"]
}
```

- `enabled` — the deployment switch. When `false` (or the block is absent) no SDK
  is created, no fetch instrumentation is registered and no OTLP request is made.
- `otlpBaseUrl` — collector base URL. A path is resolved against the page origin,
  so `/otlp` posts same-origin (Tempo's receiver sends no CORS headers; in the
  compose stack traefik routes `/otlp` to `tempo:4318`). Use an absolute URL with
  CORS for a remote collector.
- `serviceName` — the `service.name` resource attribute.
- `propagateTo` — origin regexes that receive the W3C `traceparent` header (the
  SAI servers reflect it in their CORS preflight).
- `captureBodies` — record request/response payloads on the `sai.lws.*` client
  spans (`sai.lws.request.body`, `sai.lws.response.body`); JWTs inside a body are
  replaced by a digest.
- `captureTokens` — record the decoded header/claims of the credentials the
  client handles (`sai.token.subject.*`, `sai.token.id-jag.*`,
  `sai.token.access.*`); the raw serialized JWT stays out unless
  `captureRawTokens` is added.

With tracing on, the app emits `sai.lws.request-id-jag` and
`sai.lws.exchange-access-token` client spans; the fetch instrumentation adds
the HTTP spans and `traceparent` links them to the server spans in Tempo.
`packages/lws-auth` re-enters the client span around the actual fetch because the
app targets ESNext (native `await`; no zone.js).
