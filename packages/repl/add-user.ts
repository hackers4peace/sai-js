import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { Args, Command, Options } from '@effect/cli'
import {
  dataRegistryTemplate,
  registrySetTemplate,
  webIdTemplate,
} from '@janeirodigital/interop-data-model'
import { cssKv } from '@janeirodigital/interop-utils'
import { init } from '@paralleldrive/cuid2'
import { Console, Effect, Option } from 'effect'

const cuid = init({ length: 6 })

const datasetSourcePath = fileURLToPath(
  new URL('../../environments/data/registry.trig', import.meta.url)
)
const kvSourcePath = fileURLToPath(new URL('../../environments/data/kv.json', import.meta.url))
const mapPath = fileURLToPath(new URL('../../environments/dev/map.json', import.meta.url))

const handleArg = Args.text({ name: 'handle' }).pipe(
  Args.withDescription('User handle (e.g. charlie)')
)

const dataArg = Args.text({ name: 'data-registry' }).pipe(
  Args.withDescription('Data registry handle (e.g. charlie-home), can be repeated'),
  Args.repeated
)

const emailOption = Options.text('email').pipe(
  Options.withAlias('e'),
  Options.withDescription('Email for account password bootstrap'),
  Options.optional
)

const b64 = (str: string): string => Buffer.from(str).toString('base64url')

function addToRegistryListing(trig: string, handle: string): string {
  const match = trig.match(/GRAPH <https:\/\/registry\/> \{[\s\S]*?\n\}/)
  if (!match) {
    return trig
  }

  const graph = match[0]
  const dotIndex = graph.lastIndexOf('.')
  const entry = `,\n      <https://registry/${handle}/>`
  return trig.replace(graph, graph.slice(0, dotIndex) + entry + graph.slice(dotIndex))
}

const stripP = (s: string): string => s.replace(/^\s*PREFIX .*\n/gm, '')

function registryContent(handle: string, data: Array<string>): string {
  const id = `https://registry/${handle}/`
  const webId = `https://id/${handle}`
  const uas = `https://auth/.sai/agents/${b64(webId)}`
  const accessRequests = `https://auth/.sai/access-requests/${b64(webId)}`
  const accessGrants = `https://auth/.sai/grants/${b64(webId)}`

  let content = stripP(
    registrySetTemplate({
      id,
      webId,
      uas,
      dataRegistry: `https://data/${data[0]}/`,
    })
  )

  if (data.length > 1) {
    const extra = data
      .slice(1)
      .map((r) => `        <https://data/${r}/>`)
      .join(',\n')
    content = content.replace(
      `<https://data/${data[0]}/>.`,
      `<https://data/${data[0]}/>,\n${extra}.`
    )
  }

  for (const reg of data) {
    content += stripP(dataRegistryTemplate({ id: `https://data/${reg}/` }))
  }

  content += `
GRAPH <https://registry/${handle}/grant/> {
}

GRAPH <https://registry/${handle}/role/> {
}
`

  content += stripP(
    webIdTemplate({
      id: webId,
      document: webId,
      issuer: 'https://auth/',
      uas,
      accessRequests,
      accessGrants,
    })
  )

  return content
}

function kvEntries(
  handle: string,
  data: Array<string>,
  accountId: string,
  podIds: Array<string>,
  ownerIds: Array<string>,
  webIdLinkId: string,
  cookieId: string,
  email: Option.Option<string>
): Record<string, unknown> {
  const webId = `https://id/${handle}`
  const entries: Record<string, unknown> = {}

  const pods: Record<string, unknown> = {}
  for (let i = 0; i < data.length; i++) {
    pods[podIds[i]] = {
      baseUrl: `https://data/${data[i]}/`,
      accountId,
      id: podIds[i],
      '**owner**': {
        [ownerIds[i]]: {
          webId,
          visible: true,
          podId: podIds[i],
          id: ownerIds[i],
        },
      },
    }
  }

  const accountData: Record<string, unknown> = {
    linkedLoginsCount: 1,
    id: accountId,
    '**uiPushSubscription**': {},
    '**reciprocalWebhook**': {},
    '**password**': {},
    '**clientCredentials**': {},
    '**pod**': pods,
    '**webIdLink**': {
      [webIdLinkId]: {
        webId,
        accountId,
        id: webIdLinkId,
      },
    },
  }

  if (Option.isSome(email)) {
    const passwordId = crypto.randomUUID()
    const passwordEntry = {
      accountId,
      email: email.value,
      password: '$2b$10$lhqm/yiyPZfpc1SjXBCPneugEwn/LHDIPr9QRVIjvmJoJyAkyqV.G',
      verified: true,
      id: passwordId,
    }
    accountData['**password**'] = { [passwordId]: passwordEntry }
    entries[cssKv.password(passwordId)] = [accountId]
    entries[cssKv.passwordByEmail(email.value)] = [accountId]
  }

  entries[cssKv.accountData(accountId)] = accountData
  entries[cssKv.webIdLink(webIdLinkId)] = [accountId]
  entries[cssKv.webIdLinkByWebId(webId)] = [accountId]
  entries[cssKv.cookie(cookieId)] = {
    expires: '3026-01-08T18:05:16.680Z',
    payload: accountId,
  }

  for (let i = 0; i < data.length; i++) {
    entries[cssKv.owner(ownerIds[i])] = [accountId]
    entries[cssKv.pod(podIds[i])] = [accountId]
    entries[cssKv.podByBaseUrl(`https://data/${data[i]}/`)] = [accountId]
  }

  return entries
}

const addUserCommand = Command.make(
  'add-user',
  { handle: handleArg, data: dataArg, email: emailOption },
  ({ handle, data, email }) =>
    Effect.gen(function* () {
      yield* Console.log(`Adding user: ${handle}`)

      if (data.length === 0) {
        yield* Console.error('At least one data registry is required')
        return 1
      }

      const trig = readFileSync(datasetSourcePath, 'utf-8')
      const kvStr = readFileSync(kvSourcePath, 'utf-8')
      const mapStr = readFileSync(mapPath, 'utf-8')

      const kv: Record<string, unknown> = JSON.parse(kvStr)
      const map: { agents: Record<string, string>; prefixes: Record<string, string> } =
        JSON.parse(mapStr)

      const webId = `https://id/${handle}`
      if (map.agents[webId]) {
        yield* Console.error(`User "${handle}" already exists in map.json`)
        return 1
      }

      if (trig.includes(`GRAPH <meta:https://registry/${handle}/>`)) {
        yield* Console.error(`User "${handle}" already exists in registry.trig`)
        return 1
      }

      // Update map.json
      map.agents[webId] = `https://${handle}.id.docker`
      for (const reg of data) {
        const dataUrl = `https://data/${reg}/`
        map.prefixes[dataUrl] = `https://${reg}.data.docker/`
        map.prefixes[`meta:${dataUrl}`] = `meta:https://${reg}.data.docker/`
      }
      yield* Effect.sync(() => writeFileSync(mapPath, `${JSON.stringify(map, null, 2)}\n`))

      // Update registry.trig
      const updatedTrig = addToRegistryListing(trig, handle) + registryContent(handle, data)
      yield* Effect.sync(() => writeFileSync(datasetSourcePath, updatedTrig, 'utf-8'))

      // Update kv.json
      const accountId = crypto.randomUUID()
      const podIds = data.map(() => crypto.randomUUID())
      const ownerIds = data.map(() => crypto.randomUUID())
      const webIdLinkId = crypto.randomUUID()
      const cookieId = crypto.randomUUID()

      Object.assign(
        kv,
        kvEntries(handle, data, accountId, podIds, ownerIds, webIdLinkId, cookieId, email)
      )
      yield* Effect.sync(() => writeFileSync(kvSourcePath, `${JSON.stringify(kv, null, 2)}\n`))

      yield* Console.log(`User "${handle}" added successfully`)
      yield* Console.log(`Cookie: css-account=${cookieId}`)
      return 0
    }).pipe(
      Effect.catchAll((error: Error) =>
        Effect.gen(function* () {
          yield* Console.error(`Error adding user: ${error.message}`)
          return 1
        })
      )
    )
).pipe(Command.withDescription('Add a new user to the test fixture data'))

export { addUserCommand, cuid }
