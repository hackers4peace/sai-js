import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Args, Command, Options } from '@effect/cli'
import * as NodeContext from '@effect/platform-node/NodeContext'
import * as Runtime from '@effect/platform-node/NodeRuntime'
import { Postgres, seedQuadstore } from '@janeirodigital/interop-test-utils'
import { Console, Effect, Option } from 'effect'
import { exportJWK, generateKeyPair } from 'jose'

const datasetSourcePath = fileURLToPath(
  new URL('../css-storage-fixture/test/registry.trig', import.meta.url)
)
const kvSourcePath = fileURLToPath(new URL('../css-storage-fixture/test/kv.json', import.meta.url))
const mapPaths = {
  dev: fileURLToPath(new URL('../css-storage-fixture/dev/map.json', import.meta.url)),
  demo: fileURLToPath(new URL('../css-storage-fixture/demo/map.json', import.meta.url)),
}

const encode = (str: string): string => Buffer.from(str).toString('base64url')
const graphRegExp = /GRAPH <(https?:\/\/[^>]+)> \{/

const algorithmArg = Args.text({ name: 'algorithm' }).pipe(
  Args.withDescription(
    'The algorithm to use (e.g., ES256, RS256, ES384, ES512, PS256, PS384, PS512, EdDSA)'
  ),
  Args.withDefault('ES256')
)

const outputOption = Options.text('output').pipe(
  Options.withAlias('o'),
  Options.withDescription('Output file path for the generated JWK (defaults to stdout)'),
  Options.optional
)

const base64urlOption = Options.boolean('base64url').pipe(
  Options.withAlias('b'),
  Options.withDescription('Output as base64url-encoded JSON string (useful for env vars)'),
  Options.withDefault(false)
)

const generateJwk = (alg: string): Effect.Effect<{ privateKey: JsonWebKey }, Error> =>
  Effect.promise(async () => {
    const { privateKey } = await generateKeyPair(alg as any, { extractable: true })
    const privateJwk = { ...(await exportJWK(privateKey)), alg } as JsonWebKey
    return { privateKey: privateJwk }
  })

const encodeBase64Url = (data: string): string => {
  return Buffer.from(data).toString('base64url').replace(/=+$/, '')
}

const genJwkCommand = Command.make(
  'gen-jwk',
  { algorithm: algorithmArg, output: outputOption, base64url: base64urlOption },
  ({ algorithm, output, base64url }) =>
    Effect.gen(function* () {
      yield* Console.log(`Generating JWK with algorithm: ${algorithm}`)

      const keys = yield* generateJwk(algorithm)

      // Format output based on base64url flag
      let outputContent: string
      if (base64url) {
        const jsonString = JSON.stringify(keys.privateKey)
        outputContent = encodeBase64Url(jsonString)
      } else {
        outputContent = JSON.stringify(keys.privateKey, null, 2)
      }

      yield* Option.match(output, {
        onNone: () => Console.log(outputContent),
        onSome: (filePath) =>
          Effect.sync(() => {
            writeFileSync(filePath, outputContent)
          }).pipe(Effect.andThen(() => Console.log(`JWK saved to: ${filePath}`))),
      })

      return 0
    }).pipe(
      Effect.catchAll((error: Error) =>
        Effect.gen(function* () {
          yield* Console.error(`Error generating JWK: ${error.message}`)
          return 1
        })
      )
    )
).pipe(Command.withDescription('Generate a JSON Web Key (JWK)'))

const envOption = Options.text('env').pipe(
  Options.withAlias('e'),
  Options.withDescription('Target environment'),
  Options.withDefault('dev')
)

const datasetPathOption = Options.file('dataset').pipe(
  Options.withAlias('d'),
  Options.withDescription('Dataset output file path for the generated file'),
  Options.optional
)

const kvPathOption = Options.file('key-value').pipe(
  Options.withAlias('k'),
  Options.withDescription('Key-value output file path for the generated file'),
  Options.optional
)

const generateRegistry = (path: string, env: string): Effect.Effect<string, Error> =>
  Effect.try({
    try: () => {
      const content = readFileSync(path, 'utf-8')
      const map = JSON.parse(readFileSync(mapPaths[env], 'utf-8')) as {
        agents: Record<string, string>
        prefixes: Record<string, string>
      }

      const urlMap = {
        ...Object.fromEntries(Object.entries(map.agents).map(([k, v]) => [encode(k), encode(v)])),
        ...map.agents,
        ...map.prefixes,
      }

      const lines = content.split(/\r?\n/)
      const result = lines
        .map((line) => {
          let updated = line
          if (line.match(graphRegExp)) {
            for (const [oldUrl, newUrl] of Object.entries(map.prefixes)) {
              updated = updated.split(oldUrl).join(newUrl)
            }
          } else {
            for (const [oldUrl, newUrl] of Object.entries(urlMap)) {
              updated = updated.split(oldUrl).join(newUrl)
              // for segments in indexes in kv.json
              updated = updated.split(encodeURIComponent(oldUrl)).join(encodeURIComponent(newUrl))
            }
          }
          return updated
        })
        .join('\n')

      return result
    },
    catch: (error) => new Error(`Failed to generate data: ${error}`),
  })

const generateRegistryCommand = Command.make(
  'generate-registry',
  { datasetPath: datasetPathOption, kvPath: kvPathOption, env: envOption },
  ({ datasetPath, kvPath, env }) =>
    Effect.gen(function* () {
      yield* Console.log(`Generating data for ${env}`)

      yield* Option.match(datasetPath, {
        onNone: () => Console.log('no dataset path'),
        onSome: (filePath) =>
          Effect.gen(function* () {
            const result = yield* generateRegistry(datasetSourcePath, env)
            writeFileSync(filePath, result, 'utf-8')
          }).pipe(Effect.andThen(() => Console.log(`dataset saved to: ${filePath}`))),
      })

      yield* Option.match(kvPath, {
        onNone: () => Console.log('no key-value path'),
        onSome: (filePath) =>
          Effect.gen(function* () {
            const result = yield* generateRegistry(kvSourcePath, env)
            writeFileSync(filePath, result, 'utf-8')
          }).pipe(Effect.andThen(() => Console.log(`key-value saved to: ${filePath}`))),
      })

      yield* Console.log('Data generated successfully')

      return 0
    }).pipe(
      Effect.catchAll((error: Error) =>
        Effect.gen(function* () {
          yield* Console.error(`Error generating registry: ${error.message}`)
          return 1
        })
      )
    )
).pipe(
  Command.withDescription('Generate test registry.trig by replacing URLs from dev registry.trig')
)

const seedEnvCommand = Command.make('seed-env', { env: envOption }, ({ env }) =>
  Effect.gen(function* () {
    yield* Console.log(`Seeding data for ${env}`)

    const connectionString = 'postgres://temporal:temporal@localhost:5432/auth'
    const sparqlEndpoint = 'http://localhost:7878/store'
    const pg = new Postgres(connectionString, 'key_value')

    const kv = yield* generateRegistry(kvSourcePath, env)
    const dataset = yield* generateRegistry(datasetSourcePath, env)

    yield* Effect.promise(() => pg.seedKeyValue(JSON.parse(kv)))
    yield* Effect.promise(() => seedQuadstore(sparqlEndpoint, dataset))
    pg.sql.end()

    yield* Console.log('Data seeded successfully')
    return 0
  }).pipe(
    Effect.catchAll((error: Error) =>
      Effect.gen(function* () {
        yield* Console.error(`Error generating registry: ${error.message}`)
        return 1
      })
    )
  )
).pipe(
  Command.withDescription('Generate test registry.trig by replacing URLs from dev registry.trig')
)

const cliCommand = Command.make('interop').pipe(
  Command.withDescription('SAI Interop CLI tool'),
  Command.withSubcommands([genJwkCommand, generateRegistryCommand, seedEnvCommand])
)

const cli = Command.run(cliCommand, {
  name: 'interop',
  version: '1.0.0-rc.26',
})

cli(process.argv).pipe(Effect.provide(NodeContext.layer), Runtime.runMain)
