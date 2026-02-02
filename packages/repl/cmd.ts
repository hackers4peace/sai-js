import { writeFileSync } from 'node:fs'
import { Args, Command, Options } from '@effect/cli'
import * as NodeContext from '@effect/platform-node/NodeContext'
import * as Runtime from '@effect/platform-node/NodeRuntime'
import { Console, Effect, Option } from 'effect'
import { exportJWK, generateKeyPair } from 'jose'

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

const cliCommand = Command.make('interop').pipe(
  Command.withDescription('SAI Interop CLI tool'),
  Command.withSubcommands([genJwkCommand])
)

const cli = Command.run(cliCommand, {
  name: 'interop',
  version: '1.0.0-rc.26',
})

cli(process.argv).pipe(Effect.provide(NodeContext.layer), Runtime.runMain)
