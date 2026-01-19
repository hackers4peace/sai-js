import {
  type Container,
  type Directory,
  type Service,
  argument,
  dag,
  func,
  object,
} from '@dagger.io/dagger'

const CSS_BASE_URL = 'https://auth/'
const CSS_VAPID_PUBLIC_KEY =
  'BNUaG9vwp-WE_cX-3dNLebyczW_RivE8wHECIvZIUMUZ3co6P79neE3hueJJtFcg5ezTZ25T1ITciujz-mlAcnY'
const CSS_VAPID_PRIVATE_KEY = '8d8mM59L2VptBg5hX_2dHnQ7T5VpeUsftbaQ6PfuhGA'
const CSS_PUSH_SENDER = 'mailto:example@yourdomain.org'
const CSS_ENCODED_PRIVATE_JWK =
  'eyJrdHkiOiJFQyIsIngiOiJDMjlsZmlGbm5OV3RITHplSkxDVXpiQnN3QVJCOVZoSl9fRlBWZFlTY3FRIiwieSI6InIxVFpMQS1zbWxyOUkzSWdfc1dRcTM5R0ZjbUYwOVF6TTU3SUs4d1BxUlkiLCJjcnYiOiJQLTI1NiIsImQiOiJYcHdmRDlkN1gtc1FySWlrRW5rWE9KalVKb1JjZS1zS2ZvLXkxdkxIamVjIiwiYWxnIjoiRVMyNTYifQ'
const CSS_HTTPS_KEY = '/sai/packages/css-storage-fixture/test/certs/key.pem'
const CSS_HTTPS_CERT = '/sai/packages/css-storage-fixture/test/certs/cert.pem'
const NODE_TLS_REJECT_UNAUTHORIZED = '0'
const CSS_SPARQL_ENDPOINT = 'http://sparql/sparql'
const CSS_PORT = '443'

@object()
export class SaiJs {
  source: Directory

  constructor(
    @argument({ defaultPath: '.' })
    source: Directory
  ) {
    this.source = source
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
  oxigraphService(): Service {
    return dag
      .container()
      .from('oxigraph/oxigraph:latest')
      .withExposedPort(7878)
      .asService({ args: ['oxigraph', 'serve', '--location', '/data', '--bind', '0.0.0.0:7878'] })
      .withHostname('oxigraph')
  }

  @func()
  sparqlService(): Service {
    return dag
      .container()
      .from('nginx:alpine')
      .withMountedFile(
        '/etc/nginx/nginx.conf',
        this.source.file('packages/css-storage-fixture/oxigraph.nginx.conf')
      )
      .withServiceBinding('oxigraph', this.oxigraphService())
      .withExposedPort(80)
      .asService()
      .withHostname('sparql')
  }

  @func()
  temporalService(): Service {
    return dag
      .container()
      .from('temporalio/auto-setup:1.29.1')
      .withServiceBinding('postgresql', this.postgresService())
      .withMountedFile(
        '/etc/temporal/development-sql.yaml',
        this.source.file('temporal/development.yaml')
      )
      .withEnvVariable('DB', 'postgres12')
      .withEnvVariable('DB_PORT', '5432')
      .withEnvVariable('POSTGRES_USER', 'temporal')
      .withEnvVariable('POSTGRES_PWD', 'temporal')
      .withEnvVariable('POSTGRES_SEEDS', 'postgresql')
      .withEnvVariable('BIND_ON_IP', '0.0.0.0')
      .withExposedPort(7233)
      .asService()
      .withHostname('temporal')
  }

  @func()
  workerService(): Service {
    return dag
      .container()
      .from('node:22-slim')
      .withMountedDirectory('/sai', this.source)
      .withEnvVariable('CSS_BASE_URL', CSS_BASE_URL)
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
      .withServiceBinding('postgresql', this.postgresService())
      .withServiceBinding('temporal', this.temporalService())
      .asService({ args: ['node', '/sai/packages/components/dist/workers/main.js'] })
  }

  @func()
  idService(): Service {
    return dag
      .container()
      .from('node:24-alpine')
      .withMountedDirectory('/sai', this.source)
      .withEnvVariable('DOMAIN', 'id')
      .withEnvVariable('CSS_SPARQL_ENDPOINT', CSS_SPARQL_ENDPOINT)
      .withEnvVariable('CSS_HTTPS_KEY', CSS_HTTPS_KEY)
      .withEnvVariable('CSS_HTTPS_CERT', CSS_HTTPS_CERT)
      .withExposedPort(443)
      .withServiceBinding('sparql', this.sparqlService())
      .asService({
        args: ['node', '/sai/packages/id/https.ts'],
      })
      .withHostname('id')
  }

  @func()
  authService(): Service {
    return dag
      .container()
      .from('node:24-alpine')
      .withMountedDirectory('/sai', this.source)
      .withEnvVariable('CSS_CONFIG', '/sai/packages/css-storage-fixture/test/auth.json')
      .withEnvVariable('CSS_BASE_URL', CSS_BASE_URL)
      .withEnvVariable('CSS_AUTHORIZATION_ENDPOINT', 'https://ui.auth/authorize')
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
      .withServiceBinding('postgresql', this.postgresService())
      .withServiceBinding('temporal', this.temporalService())
      .withServiceBinding('id', this.idService())
      .withServiceBinding('registry', this.registryService())
      .withServiceBinding('data', this.dataService())
      .withExposedPort(443)
      .withExposedPort(9229)
      .asService({
        args: [
          'node',
          '--inspect=0.0.0.0:9229',
          '/sai/node_modules/@solid/community-server/bin/server.js',
        ],
      })
      .withHostname('auth')
  }

  @func()
  registryService(): Service {
    return dag
      .container()
      .from('node:24-alpine')
      .withMountedDirectory('/sai', this.source)
      .withEnvVariable('CSS_CONFIG', '/sai/packages/css-storage-fixture/test/registry.json')
      .withEnvVariable('CSS_BASE_URL', 'https://registry/')
      .withEnvVariable('CSS_PORT', CSS_PORT)
      .withEnvVariable('CSS_SPARQL_ENDPOINT', CSS_SPARQL_ENDPOINT)
      .withEnvVariable('CSS_HTTPS_KEY', CSS_HTTPS_KEY)
      .withEnvVariable('CSS_HTTPS_CERT', CSS_HTTPS_CERT)
      .withEnvVariable(
        'CSS_POSTGRES_CONNECTION_STRING',
        'postgres://temporal:temporal@postgresql:5432/registry'
      )
      .withEnvVariable('NODE_TLS_REJECT_UNAUTHORIZED', NODE_TLS_REJECT_UNAUTHORIZED)
      .withExposedPort(443)
      .withServiceBinding('postgresql', this.postgresService())
      .withServiceBinding('sparql', this.sparqlService())
      .withExposedPort(9230)
      .asService({
        args: [
          'node',
          '--inspect=0.0.0.0:9230',
          '/sai/node_modules/@solid/community-server/bin/server.js',
        ],
      })
      .withHostname('registry')
  }

  @func()
  dataService(): Service {
    return dag
      .container()
      .from('node:24-alpine')
      .withMountedDirectory('/sai', this.source)
      .withEnvVariable('CSS_CONFIG', '/sai/packages/css-storage-fixture/test/data.json')
      .withEnvVariable('CSS_ROOT_FILE_PATH', '/sai/packages/css-storage-fixture/test/data')
      .withEnvVariable('CSS_BASE_URL', 'https://data/')
      .withEnvVariable('CSS_PORT', CSS_PORT)
      .withEnvVariable('CSS_HTTPS_KEY', CSS_HTTPS_KEY)
      .withEnvVariable('CSS_HTTPS_CERT', CSS_HTTPS_CERT)
      .withEnvVariable('CSS_SPARQL_ENDPOINT', CSS_SPARQL_ENDPOINT)
      .withEnvVariable(
        'CSS_POSTGRES_CONNECTION_STRING',
        'postgres://temporal:temporal@postgresql:5432/auth'
      )
      .withEnvVariable('NODE_TLS_REJECT_UNAUTHORIZED', NODE_TLS_REJECT_UNAUTHORIZED)
      .withExposedPort(443)
      .withServiceBinding('postgresql', this.postgresService())
      .withServiceBinding('sparql', this.sparqlService())
      .withExposedPort(9231)
      .asService({
        args: [
          'node',
          '--inspect=0.0.0.0:9231',
          '/sai/node_modules/@solid/community-server/bin/server.js',
        ],
      })
      .withHostname('data')
  }

  testBase(): Container {
    return dag
      .container()
      .from('node:24-alpine')
      .withMountedDirectory('/sai', this.source)
      .withEnvVariable('NODE_TLS_REJECT_UNAUTHORIZED', NODE_TLS_REJECT_UNAUTHORIZED)
      .withEnvVariable('CSS_BASE_URL', CSS_BASE_URL)
      .withEnvVariable('CSS_ENCODED_PRIVATE_JWK', CSS_ENCODED_PRIVATE_JWK)
      .withServiceBinding('auth', this.authService())
      .withServiceBinding('registry', this.registryService())
      .withServiceBinding('data', this.dataService())
      .withServiceBinding('worker', this.workerService())
      .withServiceBinding('sparql', this.sparqlService())
      .withServiceBinding('id', this.idService())
      .withWorkdir('/sai/test')
  }

  @func()
  async test(
    @argument()
    testFile?: string
  ): Promise<string> {
    const args = ['npm', 'run', 'dagger:test']
    if (testFile) {
      args.push(testFile)
    }
    return this.testBase().withExec(args).stdout()
  }

  @func()
  debugService(
    @argument()
    testFile?: string
  ): Service {
    const args = ['npm', 'run', 'dagger:debug']
    if (testFile) {
      args.push(testFile)
    }
    return this.testBase().withExposedPort(9240).asService({ args })
  }

  @func()
  proxyService(
    @argument()
    testFile?: string
  ): Service {
    return dag
      .container()
      .from('node:24-alpine')
      .withServiceBinding('debug', this.debugService(testFile))
      .withServiceBinding('auth', this.authService())
      .withServiceBinding('registry', this.registryService())
      .withServiceBinding('data', this.dataService())
      .withMountedFile('/proxy.js', this.source.file('test/proxy.js'))
      .withExposedPort(9240)
      .withExposedPort(9229)
      .withExposedPort(9230)
      .withExposedPort(9231)
      .withExposedPort(443)
      .asService({ args: ['node', '/proxy.js'] })
  }

  @func()
  tmp(): Container {
    return dag.container().from('alpine').withServiceBinding('id', this.idService()).terminal()
  }

  @func()
  cli(): Container {
    return dag
      .container()
      .from('alpine:3.20')
      .withServiceBinding('temporal', this.temporalService())
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
}
