import { randomUUID } from 'node:crypto'

import type { Container, Directory, File, Secret, Service } from '@dagger.io/dagger'
import { ReturnType, argument, dag, func, object } from '@dagger.io/dagger'

const CSS_BASE_URL = 'https://auth/'
const CSS_ID_ORIGIN = 'id'
const CSS_DOC_ORIGIN = 'id'
const CSS_DATA_ORIGIN = 'data'
const CSS_REG_ORIGIN = 'registry'
const CSS_VAPID_PUBLIC_KEY =
  'BNUaG9vwp-WE_cX-3dNLebyczW_RivE8wHECIvZIUMUZ3co6P79neE3hueJJtFcg5ezTZ25T1ITciujz-mlAcnY'
const CSS_VAPID_PRIVATE_KEY = '8d8mM59L2VptBg5hX_2dHnQ7T5VpeUsftbaQ6PfuhGA'
const CSS_PUSH_SENDER = 'mailto:example@yourdomain.org'
const CSS_ENCODED_PRIVATE_JWK =
  'eyJrdHkiOiJFQyIsIngiOiJDMjlsZmlGbm5OV3RITHplSkxDVXpiQnN3QVJCOVZoSl9fRlBWZFlTY3FRIiwieSI6InIxVFpMQS1zbWxyOUkzSWdfc1dRcTM5R0ZjbUYwOVF6TTU3SUs4d1BxUlkiLCJjcnYiOiJQLTI1NiIsImQiOiJYcHdmRDlkN1gtc1FySWlrRW5rWE9KalVKb1JjZS1zS2ZvLXkxdkxIamVjIiwiYWxnIjoiRVMyNTYifQ'
const CSS_HTTPS_KEY = '/sai/environments/css/certs/key.pem'
const CSS_HTTPS_CERT = '/sai/environments/css/certs/cert.pem'
const NODE_TLS_REJECT_UNAUTHORIZED = '0'
const CSS_FUSEKI_BASE_URL = 'http://fuseki:3030'
const CSS_ID_SPARQL_ENDPOINT = 'http://fuseki:3030/id/sparql'
const CSS_S3_ENDPOINT = 'http://garage:3900'
const CSS_S3_REGION = 'garage'
const CSS_GARAGE_ADMIN_ENDPOINT = 'http://garage:3903'
const CSS_GARAGE_ADMIN_TOKEN = '5jEN9DfkbpeU0WCh68pl2GiQk11CfApGiLKpQZc1L5o='
const CSS_PORT = '443'

const POSTGRESQL_VERSION = '16'
const TEMPORAL_VERSION = '1.31.0'
const TEMPORAL_ADMINTOOLS_VERSION = '1.31.0'

// OpenTelemetry is OPT-IN and configured per invocation via the module's
// `--tempo-endpoint` argument (constructor arg, so it applies to every
// function), e.g.
//   dagger call --tempo-endpoint=http://172.16.0.1:4318 test
// `172.16.0.1` is the docker host on the compose network gateway — the compose
// DNS name `tempo` is not resolvable from the engine's exec containers. When
// the argument is omitted, tracing is hard-disabled so local/CI runs need no
// Tempo service.
// NB `process.env` is not an option here: the Dagger engine does not forward
// the calling shell's environment to module code, so a host TEMPO_OTLP_ENDPOINT
// would silently read as unset.
// The endpoint travels to the containers as SAI_OTLP_ENDPOINT, not
// OTEL_EXPORTER_OTLP_ENDPOINT: the engine injects and overrides the latter with
// its own telemetry endpoint, so `withTracing` also pins OTEL_SDK_DISABLED=true
// in the off case — otherwise the tracing gate would fall back to that
// injected endpoint.

type LogLevel = 'error' | 'warn' | 'info' | 'verbose' | 'debug' | 'silly'

const CSS_LOG_LEVEL: LogLevel = 'warn'

const NIX_IMAGE = 'nixos/nix'
// Runtime for every service/test container in this module (D5 = A: Node 26
// everywhere). slim = Debian/glibc, matching the host-built node_modules and the
// Temporal native core addon.
const NODE_IMAGE = 'node:26-slim'
const SKOPEO_IMAGE = 'quay.io/skopeo/stable:latest'
// keep in step with @playwright/test in ui/authorization/package.json
const PLAYWRIGHT_IMAGE = 'mcr.microsoft.com/playwright:v1.65.1-noble'

/** Waits (from a dir that resolves @temporalio/client) until Temporal accepts connections. */
const TEMPORAL_READY = `
  import { Connection } from '@temporalio/client'
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await Connection.connect({
        address: process.env.TEMPORAL_ADDRESS,
        connectTimeout: 1000,
      })
      process.exit(0)
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }
  console.error('Temporal is not reachable')
  process.exit(1)
`

/** Static HTTPS server for a built SPA with fallback to index.html. */
function staticServer(root: string): string {
  return `
  import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
  import { createServer } from 'node:https'
  import { extname, join, normalize } from 'node:path'

  const root = '${root}'
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.webmanifest': 'application/manifest+json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.eot': 'application/vnd.ms-fontobject',
  }
  const tls = {
    key: readFileSync('${CSS_HTTPS_KEY}'),
    cert: readFileSync('${CSS_HTTPS_CERT}'),
  }
  createServer(tls, (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'https://spa').pathname))
    let file = join(root, path)
    if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) {
      file = join(root, 'index.html')
    }
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' })
    createReadStream(file).pipe(res)
  }).listen(443)
`
}

const UI_STATIC_SERVER = staticServer('/sai/ui/authorization/dist')
const VUEJECTRON_STATIC_SERVER = staticServer('/sai/examples/vuejectron/dist')
const IMAGE_SUFFIX = '-image'

type Arch = 'amd64' | 'arm64'

function systemToArch(system: string): Arch {
  switch (system) {
    case 'x86_64-linux':
      return 'amd64'
    case 'aarch64-linux':
      return 'arm64'
    default:
      throw new Error(`Unsupported system: ${system}`)
  }
}

function imageBaseName(image: string): string {
  return image.endsWith(IMAGE_SUFFIX) ? image.slice(0, -IMAGE_SUFFIX.length) : image
}

@object()
export class SaiJs {
  source: Directory
  tempoEndpoint?: string
  css?: Directory

  constructor(
    @argument({ defaultPath: '.' })
    source: Directory,
    @argument()
    tempoEndpoint?: string,
    /**
     * Optional local CommunitySolidServer checkout, for example
     * `--css=../CommunitySolidServer`. Build the checkout before passing it.
     * Dagger mounts it over the installed package, so no host `npm link` (and
     * no symlink escaping this source directory) is needed. Without this
     * argument, local and CI runs use the fork pinned in package-lock.json.
     */
    css?: Directory
  ) {
    this.source = source
    this.tempoEndpoint = tempoEndpoint
    this.css = css
  }

  /**
   * OpenTelemetry env for one instrumented process. Tempo is opt-in via the
   * module's `--tempo-endpoint` argument (see the module-level note). When it
   * is unset this pins OTEL_SDK_DISABLED=true so the tracing gate cannot fall
   * back to the OTLP endpoint the Dagger engine injects for its own telemetry.
   */
  /**
   * A Node service/test container with the repo mounted at `/sai` and, when
   * `--css` is set, the local CommunitySolidServer checkout mounted over the
   * installed package. The source mount is applied first: Dagger resolves
   * overlapping mounts in favor of the last one, so the CSS mount must come
   * after `/sai` for `css-local` to actually use the local build.
   */
  private nodeContainer(serviceName: string, runId: string): Container {
    const container = this.withTracing(dag.container().from(NODE_IMAGE), serviceName)
      .withEnvVariable('SAI_RUN_ID', runId)
      .withMountedDirectory('/sai', this.source)
    if (!this.css) {
      return container
    }
    return container.withMountedDirectory('/sai/node_modules/@solid/community-server', this.css)
  }

  private withTracing(container: Container, serviceName: string): Container {
    if (!this.tempoEndpoint) {
      return container.withEnvVariable('OTEL_SDK_DISABLED', 'true')
    }
    return (
      container
        .withEnvVariable('SAI_OTLP_ENDPOINT', this.tempoEndpoint)
        .withEnvVariable('OTEL_SERVICE_NAME', serviceName)
        // headers carry real session tokens — only ever send them to our Tempo
        .withEnvVariable('OTEL_CAPTURE_HEADERS', 'true')
        // decoded JWT headers/claims of the LWS token chain (never the raw token)
        .withEnvVariable('OTEL_CAPTURE_TOKENS', 'true')
        // token request/response payloads (form body, JSON body)
        .withEnvVariable('OTEL_CAPTURE_BODIES', 'true')
    )
  }

  @func()
  postgresService(): Service {
    return dag
      .container()
      .from('postgres:18')
      .withEnvVariable('POSTGRES_USER', 'temporal')
      .withEnvVariable('POSTGRES_PASSWORD', 'temporal')
      .withEnvVariable('POSTGRES_DB', 'temporal')
      .withExposedPort(5432)
      .asService()
      .withHostname('postgresql')
  }

  @func()
  fusekiService(): Service {
    return (
      dag
        .container()
        .from('secoresearch/fuseki:5.6.0')
        .withMountedFile(
          '/tmp/fuseki.config.ttl',
          this.source.file('environments/css/fuseki.config.ttl')
        )
        // deterministic admin password for the Fuseki admin API: the image's
        // entrypoint writes `admin=$ADMIN_PASSWORD` into shiro.ini, and auth
        // passes the same value as CSS_FUSEKI_ADMIN so new signups can create
        // their per-pod datasets dynamically
        .withEnvVariable('ADMIN_PASSWORD', 'sai')
        .withExposedPort(3030)
        .asService({
          // the image entrypoint initializes $FUSEKI_BASE/shiro.ini; keep it and
          // pass the FusekiServerCmd invocation as its args
          useEntrypoint: true,
          args: [
            'java',
            '-cp',
            '*:/javalibs/*',
            'org.apache.jena.fuseki.main.cmds.FusekiServerCmd',
            '--conf',
            '/tmp/fuseki.config.ttl',
          ],
        })
        .withHostname('fuseki')
    )
  }

  @func()
  garageService(): Service {
    return dag
      .container()
      .from('dxflrs/garage:v2.2.0')
      .withMountedFile('/etc/garage.toml', this.source.file('environments/garage/garage.toml'))
      .withMountedDirectory(
        '/var/lib/garage/meta',
        this.source.directory('environments/garage/meta')
      )
      .withMountedDirectory(
        '/var/lib/garage/data',
        this.source.directory('environments/garage/data')
      )
      .withExposedPort(3900)
      .withExposedPort(3901)
      .withExposedPort(3902)
      .withExposedPort(3903)
      .asService()
      .withHostname('garage')
  }

  @func({ cache: 'session' })
  async temporalService(): Promise<Service> {
    return this.temporalServiceFor(randomUUID())
  }

  // The run ID must be generated once per entrypoint, not in the cacheable
  // constructor: Dagger keeps module results across CLI invocations, and a
  // frozen ID would make setup-postgres.sh a cache hit against a fresh,
  // empty Postgres service. Private builders receive the ID so every service
  // in one stack shares the same ephemeral database and cache-busting key.
  private async temporalServiceFor(runId: string): Promise<Service> {
    const scripts = this.source.directory('environments/temporal/scripts')
    const dynamicConfig = this.source.directory('environments/temporal/dynamicconfig')

    // Postgres and Temporal are started explicitly (Service.start) and stay up
    // for the whole session. Bound-only services are "started just-in-time
    // ... and stopped when no longer needed": the short setup execs below
    // (schema, namespace) were their only clients, so they stopped after the
    // grace period and came back as FRESH containers — an empty, schema-less
    // database, no namespace — with the SAI worker's pollers dropped meanwhile.
    const pg = await dag
      .container()
      .from(`postgres:${POSTGRESQL_VERSION}`)
      .withEnvVariable('POSTGRES_PASSWORD', 'temporal')
      .withEnvVariable('POSTGRES_USER', 'temporal')
      .withEnvVariable('SAI_RUN_ID', runId)
      // Keep database state in the service container's ephemeral layer. A
      // named cache volume would leak schemas and data between test runs.
      .withExposedPort(5432)
      .asService({ useEntrypoint: true })
      .start()

    await dag
      .container()
      .from(`postgres:${POSTGRESQL_VERSION}`)
      .withServiceBinding('postgresql', pg)
      .withEnvVariable('SAI_RUN_ID', runId)
      .withEntrypoint([])
      .withExec([
        '/bin/sh',
        '-c',
        'for i in $(seq 60); do pg_isready -U temporal -h postgresql && exit 0; done; exit 1',
      ])
      .sync()

    await dag
      .container()
      .from(`temporalio/admin-tools:${TEMPORAL_ADMINTOOLS_VERSION}`)
      .withServiceBinding('postgresql', pg)
      .withEnvVariable('POSTGRES_SEEDS', 'postgresql')
      .withEnvVariable('POSTGRES_USER', 'temporal')
      .withEnvVariable('SQL_PASSWORD', 'temporal')
      .withEnvVariable('DB_PORT', '5432')
      .withEnvVariable('SAI_RUN_ID', runId)
      .withDirectory('/scripts', scripts)
      // Include runId in the exec args as well as the env: Dagger 0.21.12 can
      // otherwise serve a cached setup run against a fresh Postgres service.
      .withExec(['/bin/sh', '-c', `echo ${runId} && exec /bin/sh /scripts/setup-postgres.sh`])
      .sync()

    const temporal = await dag
      .container()
      .from(`temporalio/server:${TEMPORAL_VERSION}`)
      .withServiceBinding('postgresql', pg)
      .withEnvVariable('DB', 'postgres12')
      .withEnvVariable('DB_PORT', '5432')
      .withEnvVariable('POSTGRES_USER', 'temporal')
      .withEnvVariable('POSTGRES_PWD', 'temporal')
      .withEnvVariable('POSTGRES_SEEDS', 'postgresql')
      .withEnvVariable('BIND_ON_IP', '0.0.0.0')
      .withEnvVariable('SAI_RUN_ID', runId)
      .withEnvVariable('DYNAMIC_CONFIG_FILE_PATH', 'config/dynamicconfig/development-sql.yaml')
      .withDirectory('/etc/temporal/config/dynamicconfig', dynamicConfig)
      .withExposedPort(7233)
      .withEntrypoint([
        '/bin/sh',
        '-c',
        'while ! nc -z postgresql 5432 2>/dev/null; do sleep 1; done && ' +
          'sleep 2 && ' +
          'unset OTEL_EXPORTER_OTLP_TRACES_PROTOCOL && ' +
          'exec /etc/temporal/entrypoint.sh start',
      ])
      .asService({ useEntrypoint: true })
      .start()

    await dag
      .container()
      .from(`temporalio/admin-tools:${TEMPORAL_ADMINTOOLS_VERSION}`)
      .withServiceBinding('temporal', temporal)
      .withEnvVariable('TEMPORAL_ADDRESS', 'temporal:7233')
      .withEnvVariable('DEFAULT_NAMESPACE', 'default')
      .withEnvVariable('SAI_RUN_ID', runId)
      .withDirectory('/scripts', scripts)
      .withExec(['/bin/sh', '-c', `echo ${runId} && exec /bin/sh /scripts/create-namespace.sh`])
      .sync()

    return temporal
  }

  @func({ cache: 'session' })
  async workerService(): Promise<Service> {
    const runId = randomUUID()
    const temporal = await this.temporalServiceFor(runId)
    return this.workerServiceFor(runId, temporal)
  }

  private async workerServiceFor(runId: string, temporal: Service): Promise<Service> {
    return (
      this.nodeContainer('sai-worker', runId)
        .withEnvVariable('CSS_BASE_URL', CSS_BASE_URL)
        .withEnvVariable('CSS_ID_ORIGIN', CSS_ID_ORIGIN)
        .withEnvVariable('CSS_REG_ORIGIN', CSS_REG_ORIGIN)
        .withEnvVariable('CSS_VAPID_PUBLIC_KEY', CSS_VAPID_PUBLIC_KEY)
        .withEnvVariable('CSS_VAPID_PRIVATE_KEY', CSS_VAPID_PRIVATE_KEY)
        .withEnvVariable('CSS_PUSH_SENDER', CSS_PUSH_SENDER)
        .withEnvVariable('CSS_ENCODED_PRIVATE_JWK', CSS_ENCODED_PRIVATE_JWK)
        .withEnvVariable(
          'CSS_POSTGRES_CONNECTION_STRING',
          'postgres://temporal:temporal@postgresql:5432/auth'
        )
        .withEnvVariable('NODE_TLS_REJECT_UNAUTHORIZED', NODE_TLS_REJECT_UNAUTHORIZED)
        .withEnvVariable('TEMPORAL_ADDRESS', 'temporal:7233')
        // account-bootstrap activities: Fuseki dataset creation + GSP, Garage
        // bucket/key provisioning, the S3 endpoint the record carries
        .withEnvVariable('CSS_FUSEKI_BASE_URL', CSS_FUSEKI_BASE_URL)
        .withEnvVariable('CSS_FUSEKI_ADMIN', 'admin:sai')
        .withEnvVariable('CSS_S3_ENDPOINT', CSS_S3_ENDPOINT)
        .withEnvVariable('CSS_GARAGE_ADMIN_ENDPOINT', CSS_GARAGE_ADMIN_ENDPOINT)
        .withEnvVariable('CSS_GARAGE_ADMIN_TOKEN', CSS_GARAGE_ADMIN_TOKEN)
        // temporal activities query/update the registry store directly (e.g.
        // syncReciprocalMirror, org-context-sparql.md) — currently dormant, env
        // kept so re-enabling needs no dagger change
        .withServiceBinding('postgresql', this.postgresService())
        .withServiceBinding('temporal', temporal)
        .withServiceBinding('fuseki', this.fusekiService())
        .withServiceBinding('garage', this.garageService())
        .withExposedPort(9235)
        .asService({
          args: ['node', '--inspect=0.0.0.0:9235', '/sai/packages/components/dist/workers/main.js'],
        })
        .withHostname('worker')
    )
  }

  @func({ cache: 'session' })
  idService(): Service {
    const runId = randomUUID()
    return this.nodeContainer('sai-id', runId)
      .withEnvVariable('ID_ORIGIN', 'id')
      .withEnvVariable('DOC_ORIGIN', 'id')
      .withEnvVariable('CSS_ID_SPARQL_ENDPOINT', CSS_ID_SPARQL_ENDPOINT)
      .withEnvVariable('CSS_HTTPS_KEY', CSS_HTTPS_KEY)
      .withEnvVariable('CSS_HTTPS_CERT', CSS_HTTPS_CERT)
      .withExposedPort(443)
      .withServiceBinding('fuseki', this.fusekiService())
      .asService({
        args: [
          'node',
          '--require=/sai/packages/components/src/tracing/preload.cjs',
          '/sai/services/id/https.ts',
        ],
      })
      .withHostname('id')
  }

  @func({ cache: 'session' })
  async authService(): Promise<Service> {
    const runId = randomUUID()
    const temporal = await this.temporalServiceFor(runId)
    return this.authServiceFor(runId, temporal)
  }

  private async authServiceFor(runId: string, temporal: Service): Promise<Service> {
    return this.nodeContainer('sai-uas', runId)
      .withEnvVariable('CSS_CONFIG', '/sai/environments/css/https/auth.json')
      .withEnvVariable('CSS_BASE_URL', CSS_BASE_URL)
      .withEnvVariable('CSS_AUTHORIZATION_ENDPOINT', 'https://ui.auth/authorize')
      .withEnvVariable('CSS_LOGGING_LEVEL', CSS_LOG_LEVEL)
      .withEnvVariable('CSS_PORT', CSS_PORT)
      .withEnvVariable('CSS_HTTPS_KEY', CSS_HTTPS_KEY)
      .withEnvVariable('CSS_HTTPS_CERT', CSS_HTTPS_CERT)
      .withEnvVariable('CSS_VAPID_PUBLIC_KEY', CSS_VAPID_PUBLIC_KEY)
      .withEnvVariable('CSS_VAPID_PRIVATE_KEY', CSS_VAPID_PRIVATE_KEY)
      .withEnvVariable('CSS_PUSH_SENDER', CSS_PUSH_SENDER)
      .withEnvVariable('CSS_ENCODED_PRIVATE_JWK', CSS_ENCODED_PRIVATE_JWK)
      .withEnvVariable(
        'CSS_POSTGRES_CONNECTION_STRING',
        'postgres://temporal:temporal@postgresql:5432/auth'
      )
      .withEnvVariable('TEMPORAL_ADDRESS', 'temporal:7233')
      .withEnvVariable('NODE_TLS_REJECT_UNAUTHORIZED', NODE_TLS_REJECT_UNAUTHORIZED)
      .withEnvVariable('CSS_ID_ORIGIN', CSS_ID_ORIGIN)
      .withEnvVariable('CSS_DOC_ORIGIN', CSS_DOC_ORIGIN)
      .withEnvVariable('CSS_DATA_ORIGIN', CSS_DATA_ORIGIN)
      .withEnvVariable('CSS_REG_ORIGIN', CSS_REG_ORIGIN)
      .withEnvVariable('CSS_FUSEKI_BASE_URL', CSS_FUSEKI_BASE_URL)
      .withEnvVariable('CSS_FUSEKI_ADMIN', 'admin:sai')
      .withServiceBinding('postgresql', this.postgresService())
      .withServiceBinding('temporal', temporal)
      .withServiceBinding('id', this.idService())
      .withServiceBinding('registry', await this.registryServiceFor(runId, temporal))
      .withServiceBinding('data', await this.dataServiceFor(runId, temporal))
      .withServiceBinding('fuseki', this.fusekiService())
      .withServiceBinding('garage', this.garageService())
      .withExposedPort(443)
      .withExposedPort(9229)
      .asService({
        args: [
          'node',
          '--inspect=0.0.0.0:9229',
          // `--require` runs before CSS builds its HTTP server (the CJS preload
          // header explains why a preload, not an import, is needed)
          '--require=/sai/packages/components/src/tracing/preload.cjs',
          '/sai/node_modules/@solid/community-server/bin/server.js',
        ],
      })
      .withHostname('auth')
  }

  @func({ cache: 'session' })
  async registryService(): Promise<Service> {
    const runId = randomUUID()
    const temporal = await this.temporalServiceFor(runId)
    return this.registryServiceFor(runId, temporal)
  }

  private async registryServiceFor(runId: string, temporal: Service): Promise<Service> {
    return this.nodeContainer('sai-registry', runId)
      .withEnvVariable('CSS_CONFIG', '/sai/environments/css/https/registry.json')
      .withEnvVariable('CSS_BASE_URL', 'https://registry/')
      .withEnvVariable('CSS_LOGGING_LEVEL', CSS_LOG_LEVEL)
      .withEnvVariable('CSS_PORT', CSS_PORT)
      .withEnvVariable('CSS_HTTPS_KEY', CSS_HTTPS_KEY)
      .withEnvVariable('CSS_HTTPS_CERT', CSS_HTTPS_CERT)
      .withEnvVariable(
        'CSS_POSTGRES_CONNECTION_STRING',
        'postgres://temporal:temporal@postgresql:5432/auth'
      )
      .withEnvVariable('TEMPORAL_ADDRESS', 'temporal:7233')
      .withEnvVariable('NODE_TLS_REJECT_UNAUTHORIZED', NODE_TLS_REJECT_UNAUTHORIZED)
      .withExposedPort(443)
      .withServiceBinding('postgresql', this.postgresService())
      .withServiceBinding('temporal', temporal)
      .withServiceBinding('fuseki', this.fusekiService())
      .withExposedPort(9230)
      .asService({
        args: [
          'node',
          '--inspect=0.0.0.0:9230',
          '--require=/sai/packages/components/src/tracing/preload.cjs',
          '/sai/node_modules/@solid/community-server/bin/server.js',
        ],
      })
      .withHostname('registry')
  }

  @func({ cache: 'session' })
  async dataService(): Promise<Service> {
    const runId = randomUUID()
    const temporal = await this.temporalServiceFor(runId)
    return this.dataServiceFor(runId, temporal)
  }

  private async dataServiceFor(runId: string, temporal: Service): Promise<Service> {
    return this.nodeContainer('sai-data', runId)
      .withEnvVariable('CSS_CONFIG', '/sai/environments/css/https/data.json')
      .withEnvVariable('CSS_BASE_URL', 'https://data/')
      .withEnvVariable('CSS_LOGGING_LEVEL', CSS_LOG_LEVEL)
      .withEnvVariable('CSS_PORT', CSS_PORT)
      .withEnvVariable('CSS_HTTPS_KEY', CSS_HTTPS_KEY)
      .withEnvVariable('CSS_HTTPS_CERT', CSS_HTTPS_CERT)
      .withEnvVariable('CSS_ID_ORIGIN', CSS_ID_ORIGIN)
      .withEnvVariable('CSS_DOC_ORIGIN', CSS_DOC_ORIGIN)
      .withEnvVariable('CSS_DATA_ORIGIN', CSS_DATA_ORIGIN)
      .withEnvVariable('CSS_REG_ORIGIN', CSS_REG_ORIGIN)
      .withEnvVariable(
        'CSS_POSTGRES_CONNECTION_STRING',
        'postgres://temporal:temporal@postgresql:5432/auth'
      )
      .withEnvVariable('TEMPORAL_ADDRESS', 'temporal:7233')
      .withEnvVariable('NODE_TLS_REJECT_UNAUTHORIZED', NODE_TLS_REJECT_UNAUTHORIZED)
      .withEnvVariable('CSS_S3_REGION', CSS_S3_REGION)
      .withExposedPort(443)
      .withServiceBinding('postgresql', this.postgresService())
      .withServiceBinding('temporal', temporal)
      .withServiceBinding('fuseki', this.fusekiService())
      .withServiceBinding('garage', this.garageService())
      .withExposedPort(9231)
      .asService({
        args: [
          'node',
          '--inspect=0.0.0.0:9231',
          '--require=/sai/packages/components/src/tracing/preload.cjs',
          '/sai/node_modules/@solid/community-server/bin/server.js',
        ],
      })
      .withHostname('data')
  }

  /** Bind the whole SAI stack (auth, registry, data, worker, ...) under the hostnames the seed data uses. */
  private async withSaiServices(container: Container, runId: string): Promise<Container> {
    const temporal = await this.temporalServiceFor(runId)
    const auth = await this.authServiceFor(runId, temporal)
    const worker = await this.workerServiceFor(runId, temporal)
    return container
      .withServiceBinding('auth', auth)
      .withServiceBinding('registry', await this.registryServiceFor(runId, temporal))
      .withServiceBinding('data', await this.dataServiceFor(runId, temporal))
      .withServiceBinding('worker', worker)
      .withServiceBinding('temporal', temporal)
      .withServiceBinding('fuseki', this.fusekiService())
      .withServiceBinding('id', this.idService())
      .withServiceBinding('garage', this.garageService())
  }

  async testBase(runId: string): Promise<Container> {
    return (
      (await this.withSaiServices(this.nodeContainer('sai-test', runId), runId))
        .withEnvVariable('NODE_TLS_REJECT_UNAUTHORIZED', NODE_TLS_REJECT_UNAUTHORIZED)
        .withEnvVariable('CSS_BASE_URL', CSS_BASE_URL)
        .withEnvVariable('CSS_ID_ORIGIN', CSS_ID_ORIGIN)
        .withEnvVariable('CSS_REG_ORIGIN', CSS_REG_ORIGIN)
        .withEnvVariable('CSS_ENCODED_PRIVATE_JWK', CSS_ENCODED_PRIVATE_JWK)
        .withEnvVariable(
          'CSS_POSTGRES_CONNECTION_STRING',
          'postgres://temporal:temporal@postgresql:5432/auth'
        )
        .withEnvVariable('TEMPORAL_ADDRESS', 'temporal:7233')
        // the harness provisions the per-pod Garage buckets/keys itself
        .withEnvVariable('CSS_S3_ENDPOINT', CSS_S3_ENDPOINT)
        .withEnvVariable('CSS_S3_REGION', CSS_S3_REGION)
        .withEnvVariable('CSS_GARAGE_ADMIN_ENDPOINT', CSS_GARAGE_ADMIN_ENDPOINT)
        .withEnvVariable('CSS_GARAGE_ADMIN_TOKEN', CSS_GARAGE_ADMIN_TOKEN)
        .withWorkdir('/sai/test')
    )
  }

  /**
   * Run the test suite.
   *
   * Narrow to specific file(s) with
   * `--testFile="authorization.test.ts roles.test.ts"` and to a single
   * test by name with `--only="<test name>"` (maps to vitest's
   * `-t`/testNamePattern — a full test name selects exactly one test):
   *   dagger call test --testFile="authorization.test.ts" \
   *     --only="alice approves bobs request — authorization data from the request, grants follow"
   */
  @func({ cache: 'never' })
  async test(
    @argument()
    testFile?: string,
    @argument()
    only?: string
  ): Promise<string> {
    const runId = randomUUID()
    const args = ['npm', 'run', 'dagger:test']
    const filter: Array<string> = []
    if (testFile) {
      // allow multiple files: --testFile="share.test.ts roles.test.ts"
      filter.push(...testFile.split(/\s+/))
    }
    if (only) {
      // single test: vitest -t <testNamePattern>
      filter.push('-t', only)
    }
    // forward everything after the separator verbatim (npm passes `--`-suffixed
    // args straight through to the script)
    if (filter.length) {
      args.push('--', ...filter)
    }
    return (await this.testBase(runId))
      .withExec(['node', '--input-type=module', '-e', TEMPORAL_READY])
      .withExec(args)
      .stdout()
  }

  /**
   * The repo without the UI's host-installed artifacts: the UI dependencies are
   * installed inside the engine (linux), so a macOS `node_modules` never leaks in.
   */
  private uiSource(): Directory {
    return this.source
      .withoutDirectory('ui/authorization/node_modules')
      .withoutDirectory('ui/authorization/dist')
      .withoutDirectory('ui/authorization/dev-dist')
      .withoutDirectory('ui/authorization/playwright-report')
      .withoutDirectory('ui/authorization/test-results')
  }

  /** `npm ci` of the authorization UI (its own lockfile), cached across runs. */
  private uiNodeModules(): Directory {
    return dag
      .container()
      .from(NODE_IMAGE)
      .withMountedCache('/root/.npm', dag.cacheVolume('sai-ui-npm'))
      .withDirectory('/sai', this.uiSource())
      .withWorkdir('/sai/ui/authorization')
      .withExec(['npm', 'ci', '--no-audit', '--no-fund'])
      .directory('/sai/ui/authorization/node_modules')
  }

  /**
   * The authorization UI, built with Vite and served over HTTPS at
   * `https://ui.auth` (the `CSS_AUTHORIZATION_ENDPOINT` origin the auth service
   * already points at), configured for the in-engine service hostnames.
   */
  @func({ cache: 'session' })
  uiService(): Service {
    return this.uiBuild()
      .asService({ args: ['node', '/serve.mjs'] })
      .withHostname('ui.auth')
  }

  private uiBuild(): Container {
    const config = JSON.stringify({
      backendBaseUrl: 'https://auth',
      idOrigin: CSS_ID_ORIGIN,
      dataOrigin: CSS_DATA_ORIGIN,
      otlpBaseUrl: '/otlp',
      vapidPublicKey: CSS_VAPID_PUBLIC_KEY,
      languages: ['en', 'pl'],
    })
    return dag
      .container()
      .from(NODE_IMAGE)
      .withDirectory('/sai', this.uiSource())
      .withDirectory('/sai/ui/authorization/node_modules', this.uiNodeModules())
      .withWorkdir('/sai/ui/authorization')
      .withExec(['npx', 'vite', 'build'])
      .withNewFile('/sai/ui/authorization/dist/config.json', config)
      .withNewFile('/serve.mjs', UI_STATIC_SERVER)
      .withExposedPort(443)
  }

  /** The example app without its host-installed artifacts (installed in-engine). */
  private vuejectronSource(): Directory {
    return this.source
      .withoutDirectory('examples/vuejectron/node_modules')
      .withoutDirectory('examples/vuejectron/dist')
      .withoutDirectory('examples/vuejectron/dev-dist')
  }

  /** `npm ci` of the example app (its own lockfile), cached across runs. */
  private vuejectronNodeModules(): Directory {
    return dag
      .container()
      .from(NODE_IMAGE)
      .withMountedCache('/root/.npm', dag.cacheVolume('sai-vuejectron-npm'))
      .withDirectory('/sai', this.vuejectronSource())
      .withWorkdir('/sai/examples/vuejectron')
      .withExec(['npm', 'ci', '--no-audit', '--no-fund'])
      .directory('/sai/examples/vuejectron/node_modules')
  }

  /**
   * The vuejectron demo app, the stack's `test-client` application. It is served
   * at `https://test-client` — the `hasAuthorizationCallbackEndpoint` of the
   * seeded client-id document — and identifies as the canonical
   * `https://data/test-client/public/id` client. The shape-tree scopes point at
   * the in-engine copies (`https://data/shapetrees`) instead of the public
   * workers the dev/prod deployments use.
   */
  @func({ cache: 'session' })
  vuejectronService(): Service {
    return this.vuejectronBuild()
      .asService({ args: ['node', '/serve.mjs'] })
      .withHostname('test-client')
  }

  private vuejectronBuild(): Container {
    // No `authorizationOnLogin`: this stack's OIDC interaction stays on the
    // auth service's `/.account/`, so a login never carries a grant — the app
    // shows the request screen right away and only watches in the background.
    const config = JSON.stringify({
      defaultOidcIssuer: CSS_BASE_URL,
      clientId: 'https://data/test-client/public/id',
      baseUrl: 'https://test-client',
      shapeTreesOrigin: 'https://data/shapetrees',
    })
    return dag
      .container()
      .from(NODE_IMAGE)
      .withDirectory('/sai', this.vuejectronSource())
      .withDirectory('/sai/examples/vuejectron/node_modules', this.vuejectronNodeModules())
      .withWorkdir('/sai/examples/vuejectron')
      .withExec(['npx', 'vite', 'build'])
      .withNewFile('/sai/examples/vuejectron/dist/config.json', config)
      .withNewFile('/serve.mjs', VUEJECTRON_STATIC_SERVER)
      .withExposedPort(443)
  }

  private async e2eContainer(runId: string, grep?: string): Promise<Container> {
    const args = ['npx', 'playwright', 'test', '--reporter=list,html']
    if (grep) {
      args.push('--grep', grep)
    }
    // Build the UI and the demo app, and pull the Playwright image BEFORE the
    // SAI services are created: withSaiServices sets up Temporal's schema
    // eagerly, and a minutes-long build between that setup and Temporal's start
    // lets the idle Postgres service stop, so Temporal would bind to a fresh,
    // schema-less one.
    await this.uiBuild().sync()
    await this.vuejectronBuild().sync()
    const container = await dag
      .container()
      .from(PLAYWRIGHT_IMAGE)
      .withDirectory('/sai', this.uiSource())
      .withDirectory('/sai/ui/authorization/node_modules', this.uiNodeModules())
      .sync()
    return (
      (await this.withSaiServices(container, runId))
        .withServiceBinding('ui.auth', this.uiService())
        .withServiceBinding('test-client', this.vuejectronService())
        .withEnvVariable('CI', 'true')
        .withEnvVariable('TEMPORAL_ADDRESS', 'temporal:7233')
        .withEnvVariable('UI_BASE_URL', 'https://ui.auth')
        .withEnvVariable('VUEJECTRON_URL', 'https://test-client')
        .withEnvVariable('AUTH_ORIGIN', 'https://auth')
        .withEnvVariable('ALICE_ID', 'https://id/alice')
        .withEnvVariable('BOB_ID', 'https://id/bob')
        .withEnvVariable('DAN_ID', 'https://id/dan')
        .withEnvVariable('KIM_ID', 'https://id/kim')
        .withEnvVariable('NOBODY_ID', 'https://id/nobody')
        // test/seed.ts provisions the per-pod Garage buckets/keys itself
        .withEnvVariable('CSS_S3_ENDPOINT', CSS_S3_ENDPOINT)
        .withEnvVariable('CSS_S3_REGION', CSS_S3_REGION)
        .withEnvVariable('CSS_GARAGE_ADMIN_ENDPOINT', CSS_GARAGE_ADMIN_ENDPOINT)
        .withEnvVariable('CSS_GARAGE_ADMIN_TOKEN', CSS_GARAGE_ADMIN_TOKEN)
        .withEnvVariable('SAI_TEMPORAL_READY', TEMPORAL_READY)
        .withWorkdir('/sai/ui/authorization')
        // ONE exec for the readiness wait, the fixture seed and the browser run:
        // between execs Dagger stops the now client-less services and restarts
        // them, which dropped the SAI worker's Temporal pollers (workflows then
        // stalled for minutes, so "done" activity events never reached the UI)
        // and could leave the ephemeral stores empty. The readiness script
        // resolves @temporalio/client from /sai/test; the seed is
        // environments/data (the account cookies resolve only once kv.json is
        // in Postgres), as vitest's setup.ts does.
        .withExec(
          [
            'sh',
            '-c',
            '(cd /sai/test && node --input-type=module -e "$SAI_TEMPORAL_READY") && node /sai/test/seed.ts && exec "$@"',
            'sh',
            ...args,
          ],
          { expect: ReturnType.Any }
        )
    )
  }

  /**
   * Run the authorization UI Playwright suite (`ui/authorization/e2e`) in a
   * browser against the full stack. Fails when a test fails; the output is the
   * list reporter. Narrow with `--grep="<title regex>"`.
   */
  @func({ cache: 'never' })
  async playwright(@argument() grep?: string): Promise<string> {
    const run = await this.e2eContainer(randomUUID(), grep)
    const output = `${await run.stdout()}\n${await run.stderr()}`
    if ((await run.exitCode()) !== 0) {
      throw new Error(output)
    }
    return output
  }

  /**
   * Same run as `playwright`, but never fails and returns the Playwright HTML report
   * and traces, for CI artifacts:
   *   dagger call playwright-report export --path=ui/authorization/e2e-out
   */
  @func({ cache: 'never' })
  async playwrightReport(@argument() grep?: string): Promise<Directory> {
    const run = await this.e2eContainer(randomUUID(), grep)
    return dag
      .directory()
      .withDirectory('playwright-report', run.directory('playwright-report'))
      .withDirectory('test-results', run.directory('test-results'))
  }

  async debugService(
    @argument()
    testFile?: string,
    runId = randomUUID()
  ): Promise<Service> {
    const args = ['npm', 'run', 'dagger:debug']
    const filter: Array<string> = []
    if (testFile) {
      // allow multiple files: --testFile="share.test.ts roles.test.ts"
      filter.push(...testFile.split(/\s+/))
    }
    if (filter.length) {
      args.push('--', ...filter)
    }
    return (await this.testBase(runId)).withExposedPort(9240).asService({ args })
  }

  @func({ cache: 'session' })
  async proxyService(
    @argument()
    testFile?: string
  ): Promise<Service> {
    const runId = randomUUID()
    const debug = await this.debugService(testFile, runId)
    const temporal = await this.temporalServiceFor(runId)
    const auth = await this.authServiceFor(runId, temporal)
    const worker = await this.workerServiceFor(runId, temporal)
    return dag
      .container()
      .from(NODE_IMAGE)
      .withServiceBinding('debug', debug)
      .withServiceBinding('auth', auth)
      .withServiceBinding('registry', await this.registryServiceFor(runId, temporal))
      .withServiceBinding('data', await this.dataServiceFor(runId, temporal))
      .withServiceBinding('worker', worker)
      .withMountedFile('/proxy.js', this.source.file('test/proxy.js'))
      .withExposedPort(9240)
      .withExposedPort(9229)
      .withExposedPort(9230)
      .withExposedPort(9231)
      .withExposedPort(9235)
      .withExposedPort(443)
      .asService({ args: ['node', '/proxy.js'] })
  }

  @func()
  tmp(): Container {
    return dag.container().from('alpine').withServiceBinding('id', this.idService()).terminal()
  }

  @func({ cache: 'session' })
  async cli(): Promise<Container> {
    const temporal = await this.temporalService()
    return dag
      .container()
      .from('alpine:3.20')
      .withServiceBinding('temporal', temporal)
      .withExec([
        'sh',
        '-c',
        `
        set -e
        apk add --no-cache curl ca-certificates
        curl -L https://github.com/fullstorydev/grpcurl/releases/download/v1.9.1/grpcurl_1.9.1_linux_x86_64.tar.gz \
          | tar -xz -C /usr/local/bin grpcurl
        `,
      ])
      .terminal()
  }

  @func()
  async ping(): Promise<string> {
    return dag
      .container()
      .from('node:24-alpine')
      .withEnvVariable('NODE_TLS_REJECT_UNAUTHORIZED', NODE_TLS_REJECT_UNAUTHORIZED)
      .withServiceBinding('postgresql', this.postgresService())
      .withExec(['ping', '-c', '5', 'postgresql'])
      .stdout()
  }

  @func()
  buildImage(system: string, image: string): File {
    return dag
      .container()
      .from(NIX_IMAGE)
      .withMountedDirectory('/sai', this.source)
      .withWorkdir('/sai')
      .withEnvVariable('NIX_CONFIG', 'experimental-features = nix-command flakes')
      .withExec([
        'sh',
        '-c',
        `
          set -eu
          OUT=$(nix build --no-link --print-out-paths .#packages.${system}.${image})
          cp -v "$OUT" result.tar.gz
        `,
      ])
      .file('/sai/result.tar.gz')
  }

  @func()
  publishImage(
    imageFile: File,
    imageName: string,
    tag: string,
    registry: string,
    namespace: string,
    username: Secret,
    password: Secret
  ): Promise<string> {
    const ref = `${registry}/${namespace}/${imageName}:${tag}`

    return dag
      .container()
      .from(SKOPEO_IMAGE)
      .withMountedFile('/img/image.tar.gz', imageFile)
      .withSecretVariable('REGISTRY_USER', username)
      .withSecretVariable('REGISTRY_PASS', password)
      .withExec([
        'sh',
        '-c',
        `
        skopeo copy \
          --retry-times 3 \
          --dest-creds "$REGISTRY_USER:$REGISTRY_PASS" \
          docker-archive:/img/image.tar.gz \
          docker://${ref}
        `,
      ])
      .stdout()
  }

  @func()
  async publishImages(
    system: string,
    images: Array<string>,
    registry: string,
    namespace: string,
    tag: string,
    username: Secret,
    password: Secret
  ): Promise<Array<string>> {
    const arch = systemToArch(system)
    const archTag = `${tag}-${arch}`

    const refs: Array<string> = []

    for (const image of images) {
      const baseName = imageBaseName(image)

      // Build image archive for this system + image
      const file = this.buildImage(system, image)

      // Publish using secure skopeo copy with --dest-creds
      await this.publishImage(file, baseName, archTag, registry, namespace, username, password)

      refs.push(`${registry}/${namespace}/${baseName}:${archTag}`)
    }

    return refs
  }
}
