import { readFileSync, writeFileSync } from 'node:fs'
import { Args, Command, Options } from '@effect/cli'
import * as NodeContext from '@effect/platform-node/NodeContext'
import * as Runtime from '@effect/platform-node/NodeRuntime'
import { Console, Effect, Option } from 'effect'
import { exportJWK, generateKeyPair } from 'jose'

const urlMap = {
  'https://auth.docker/': 'https://auth/',
  'https://shapetrees.data.docker/trees/': 'https://data/shapetrees/trees/',
  'https://reg.docker/': 'https://registry/',
  'meta:https://reg.docker/': 'meta:https://registry/',
  'https://id.docker/': 'https://id/',
  'https://acme.id.docker': 'https://id/acme',
  'https://alice.id.docker': 'https://id/alice',
  'https://bob.id.docker': 'https://id/bob',
  'https://kim.id.docker': 'https://id/kim',
  'https://acme-rnd.data.docker/': 'https://data/acme-rnd/',
  'meta:https://acme-rnd.data.docker/': 'meta:https://data/acme-rnd/',
  'https://alice-home.data.docker/': 'https://data/alice-home/',
  'meta:https://alice-home.data.docker/': 'meta:https://data/alice-home/',
  'https://alice-work.data.docker/': 'https://data/alice-work/',
  'meta:https://alice-work.data.docker/': 'meta:https://data/alice-work/',
  'https://bob.data.docker/': 'https://data/bob/',
  'meta:https://bob.data.docker/': 'meta:https://data/bob/',
  'https://shapetrees.data.docker/': 'https://data/shapetrees/',
  'meta:https://shapetrees.data.docker/': 'meta:https://data/shapetrees/',
  'https://test-client.data.docker/': 'https://data/test-client/',
  aHR0cHM6Ly9hY21lLmlkLmRvY2tlcg: 'aHR0cHM6Ly9pZC9hY21l',
  aHR0cHM6Ly9hbGljZS5pZC5kb2NrZXI: 'aHR0cHM6Ly9pZC9hbGljZQ',
  aHR0cHM6Ly9ib2IuaWQuZG9ja2Vy: 'aHR0cHM6Ly9pZC9ib2I',
  aHR0cHM6Ly9raW0uaWQuZG9ja2Vy: 'aHR0cHM6Ly9pZC9raW0',
}

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

const registryInputOption = Options.file('input').pipe(
  Options.withAlias('i'),
  Options.withDescription('Input file path for the registry.trig file'),
  Options.withDefault('../css-storage-fixture/dev/registry.trig')
)

const registryOutputOption = Options.file('output').pipe(
  Options.withAlias('o'),
  Options.withDescription('Output file path for the generated registry.trig file'),
  Options.withDefault('../css-storage-fixture/test/registry.trig')
)

const generateRegistry = (inputPath: string, outputPath: string): Effect.Effect<void, Error> =>
  Effect.try({
    try: () => {
      const content = readFileSync(inputPath, 'utf-8')

      const sortedUrlMap = Object.entries(urlMap).sort((a, b) => b[0].length - a[0].length)

      let result = content
      for (const [oldUrl, newUrl] of sortedUrlMap) {
        result = result.split(oldUrl).join(newUrl)
        // for segments in indexes in kv.json
        result = result.split(encodeURIComponent(oldUrl)).join(encodeURIComponent(newUrl))
      }

      writeFileSync(outputPath, result, 'utf-8')
    },
    catch: (error) => new Error(`Failed to generate registry: ${error}`),
  })

const generateRegistryCommand = Command.make(
  'generate-registry',
  { input: registryInputOption, output: registryOutputOption },
  ({ input, output }) =>
    Effect.gen(function* () {
      yield* Console.log(`Generating registry from ${input} to ${output}`)

      yield* generateRegistry(input, output)

      yield* Console.log(`Registry generated successfully: ${output}`)

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
  Command.withSubcommands([genJwkCommand, generateRegistryCommand])
)

const cli = Command.run(cliCommand, {
  name: 'interop',
  version: '1.0.0-rc.26',
})

cli(process.argv).pipe(Effect.provide(NodeContext.layer), Runtime.runMain)
