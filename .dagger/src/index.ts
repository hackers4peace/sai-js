import {
  type Container,
  type Directory,
  type File,
  type Secret,
  type Service,
  argument,
  dag,
  func,
  object,
} from '@dagger.io/dagger'

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

  constructor(
    @argument({ defaultPath: '.' })
    source: Directory,
    @argument()
    tempoEndpoint?: string
  ) {
    this.source = source
    this.tempoEndpoint = tempoEndpoint
  }

  /**
   * OpenTelemetry env for one instrumented process. Tempo is opt-in via the
   * module's `--tempo-endpoint` argument (see the module-level note). When it
   * is unset this pins OTEL_SDK_DISABLED=true so the tracing gate cannot fall
   * back to the OTLP endpoint the Dagger engine injects for its own telemetry.
   */
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
      .withMountedFile('/etc/garage.toml', this.source.file('garage/garage.toml'))
      .withMountedDirectory('/var/lib/garage/meta', this.source.directory('garage/meta'))
      .withMountedDirectory('/var/lib/garage/data', this.source.directory('garage/data'))
      .withExposedPort(3900)
      .withExposedPort(3901)
      .withExposedPort(3902)
      .withExposedPort(3903)
      .asService()
      .withHostname('garage')
  }

  @func()
  async temporalService(): Promise<Service> {
    const scripts = this.source.directory('temporal/scripts')
    const dynamicConfig = this.source.directory('temporal/dynamicconfig')
    const pgData = dag.cacheVolume('temporal-pg-data-186464168168168161618')

    const pg = dag
      .container()
      .from(`postgres:${POSTGRESQL_VERSION}`)
      .withEnvVariable('POSTGRES_PASSWORD', 'temporal')
      .withEnvVariable('POSTGRES_USER', 'temporal')
      .withMountedCache('/var/lib/postgresql/data', pgData)
      .withExposedPort(5432)
      .withEntrypoint([
        '/bin/sh',
        '-c',
        'pg_resetwal -f /var/lib/postgresql/data 2>/dev/null; ' +
          'exec docker-entrypoint.sh postgres',
      ])
      .asService({ useEntrypoint: true })

    await dag
      .container()
      .from(`postgres:${POSTGRESQL_VERSION}`)
      .withServiceBinding('postgresql', pg)
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
      .withDirectory('/scripts', scripts)
      .withExec(['/bin/sh', '/scripts/setup-postgres.sh'])
      .sync()

    const temporal = dag
      .container()
      .from(`temporalio/server:${TEMPORAL_VERSION}`)
      .withServiceBinding('postgresql', pg)
      .withEnvVariable('DB', 'postgres12')
      .withEnvVariable('DB_PORT', '5432')
      .withEnvVariable('POSTGRES_USER', 'temporal')
      .withEnvVariable('POSTGRES_PWD', 'temporal')
      .withEnvVariable('POSTGRES_SEEDS', 'postgresql')
      .withEnvVariable('BIND_ON_IP', '0.0.0.0')
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

    await dag
      .container()
      .from(`temporalio/admin-tools:${TEMPORAL_ADMINTOOLS_VERSION}`)
      .withServiceBinding('temporal', temporal)
      .withEnvVariable('TEMPORAL_ADDRESS', 'temporal:7233')
      .withEnvVariable('DEFAULT_NAMESPACE', 'default')
      .withDirectory('/scripts', scripts)
      .withExec(['/bin/sh', '/scripts/create-namespace.sh'])
      .sync()

    return temporal
  }

  @func()
  @func()
  async workerService(): Promise<Service> {
    const temporal = await this.temporalService()
    return (
      this.withTracing(dag.container().from(NODE_IMAGE), 'sai-worker')
        .withMountedDirectory('/sai', this.source)
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

  @func()
  idService(): Service {
    return this.withTracing(dag.container().from(NODE_IMAGE), 'sai-id')
      .withMountedDirectory('/sai', this.source)
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

  @func()
  async authService(): Promise<Service> {
    const temporal = await this.temporalService()
    return this.withTracing(dag.container().from(NODE_IMAGE), 'sai-uas')
      .withMountedDirectory('/sai', this.source)
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
      .withServiceBinding('registry', await this.registryService())
      .withServiceBinding('data', await this.dataService())
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

  @func()
  async registryService(): Promise<Service> {
    const temporal = await this.temporalService()
    return this.withTracing(dag.container().from(NODE_IMAGE), 'sai-registry')
      .withMountedDirectory('/sai', this.source)
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

  @func()
  async dataService(): Promise<Service> {
    const temporal = await this.temporalService()
    return this.withTracing(dag.container().from(NODE_IMAGE), 'sai-data')
      .withMountedDirectory('/sai', this.source)
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

  async testBase(): Promise<Container> {
    const auth = await this.authService()
    const worker = await this.workerService()
    const temporal = await this.temporalService()
    return (
      this.withTracing(dag.container().from(NODE_IMAGE), 'sai-test')
        .withMountedDirectory('/sai', this.source)
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
        .withServiceBinding('auth', auth)
        .withServiceBinding('registry', await this.registryService())
        .withServiceBinding('data', await this.dataService())
        .withServiceBinding('worker', worker)
        .withServiceBinding('temporal', temporal)
        .withServiceBinding('fuseki', this.fusekiService())
        .withServiceBinding('id', this.idService())
        .withServiceBinding('garage', this.garageService())
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
  @func()
  async test(
    @argument()
    testFile?: string,
    @argument()
    only?: string
  ): Promise<string> {
    const args = ['npm', 'run', 'dagger:test']
    const filter: string[] = []
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
    if (filter.length) args.push('--', ...filter)
    const temporalReady = `
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
    return (await this.testBase())
      .withExec(['node', '--input-type=module', '-e', temporalReady])
      .withExec(args)
      .stdout()
  }

  async debugService(
    @argument()
    testFile?: string
  ): Promise<Service> {
    const args = ['npm', 'run', 'dagger:debug']
    const filter: string[] = []
    if (testFile) {
      // allow multiple files: --testFile="share.test.ts roles.test.ts"
      filter.push(...testFile.split(/\s+/))
    }
    if (filter.length) args.push('--', ...filter)
    return (await this.testBase()).withExposedPort(9240).asService({ args })
  }

  @func()
  async proxyService(
    @argument()
    testFile?: string
  ): Promise<Service> {
    const debug = await this.debugService(testFile)
    const auth = await this.authService()
    const worker = await this.workerService()
    return dag
      .container()
      .from(NODE_IMAGE)
      .withServiceBinding('debug', debug)
      .withServiceBinding('auth', auth)
      .withServiceBinding('registry', await this.registryService())
      .withServiceBinding('data', await this.dataService())
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

  @func()
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
    images: string[],
    registry: string,
    namespace: string,
    tag: string,
    username: Secret,
    password: Secret
  ): Promise<string[]> {
    const arch = systemToArch(system)
    const archTag = `${tag}-${arch}`

    const refs: string[] = []

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
