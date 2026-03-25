/*
1. select account from accounts
2. create session
3. select operation for example:
 - data registries
  - select registry from list of registries
    - list data registration from registry
    - add data registration to registry
      - select shape tree from list of shape trees
    - go back
*/

import * as Prompt from '@effect/cli/Prompt'
import * as NodeContext from '@effect/platform-node/NodeContext'
import * as Runtime from '@effect/platform-node/NodeRuntime'
import { Console, Context, Effect, Layer } from 'effect'

import {
  type Account,
  SolidTestUtils,
  accounts,
  createApp,
  shapeTree,
} from '@janeirodigital/css-test-utils'
import { AuthorizationAgent } from '@janeirodigital/interop-authorization-agent'
import { init } from '@paralleldrive/cuid2'

const cuid = init({ length: 6 })

export class SessionManager extends Context.Tag('SessionManager')<
  SessionManager,
  { readonly getSession: (account: Account) => Effect.Effect<AuthorizationAgent> }
>() {}

const SessionManagerLive = Layer.succeed(
  SessionManager,
  SessionManager.of({
    getSession: (account: Account) => Effect.promise(() => buildSession(account)),
  })
)

const createSelectDataRegistryPrompt = (registryList: string[]) => {
  return Prompt.select({
    message: 'Pick data registry',
    choices: registryList.map((registry) => ({ title: registry, value: registry })),
  })
}

const createSelectShapeTreePrompt = (shapeTreeList: string[]) => {
  return Prompt.select({
    message: 'Pick shape tree',
    choices: shapeTreeList.map((st) => ({ title: st, value: st })),
  })
}

const accountPrompt = Prompt.select({
  message: 'Pick account',
  choices: Object.keys(accounts).map((accountName: keyof typeof accounts) => ({
    title: accountName,
    value: accountName,
  })),
})

enum Actions {
  createDataRegistration = 'createDataRegistration',
  createSocialAgentRegistration = 'createSocialAgentRegistration',
  createApplicationRegistration = 'createApplicationRegistration',
}

const selectActionPrompt = Prompt.select({
  message: 'Select action',
  choices: [
    { title: 'Create social agent registration', value: Actions.createSocialAgentRegistration },
    { title: 'Create application registration', value: Actions.createApplicationRegistration },
    { title: 'Create data registration', value: Actions.createDataRegistration },
  ],
})

const getSession = Effect.gen(function* () {
  const sessionManager = yield* SessionManager
  const account = yield* accountPrompt
  return yield* sessionManager.getSession(accounts[account])
})

const createDataRegistration = (session: AuthorizationAgent) =>
  Effect.gen(function* () {
    const registryId = yield* createSelectDataRegistryPrompt(
      session.registrySet.hasDataRegistry.map(({ iri }) => iri)
    )
    const registry = session.registrySet.hasDataRegistry.find(({ iri }) => iri === registryId)!
    const existingShapeTrees = yield* Effect.promise(async () =>
      (await registry.registeredShapeTrees()).map(({ iri }) => iri)
    )
    const remainingShapeTrees = [
      ...new Set(Object.values(shapeTree)).difference(new Set(existingShapeTrees)),
    ]
    const shapeTreeId = yield* createSelectShapeTreePrompt(remainingShapeTrees)

    yield* Effect.promise(async () => registry.createRegistration(shapeTreeId))
  })

const createSocialAgentRegistration = (session: AuthorizationAgent) =>
  Effect.gen(function* () {
    const webId = yield* Prompt.text({ message: 'Enter social agent webId' })
    const label = yield* Prompt.text({ message: 'Enter social agent label' })
    const note = yield* Prompt.text({ message: 'Enter social agent note (optional)' })

    yield* Effect.promise(async () =>
      session.registrySet.hasAgentRegistry.addSocialAgentRegistration(webId, label, note)
    )
  })

const createApplicationRegistration = (session: AuthorizationAgent) =>
  Effect.gen(function* () {
    const clientId = yield* Prompt.text({ message: 'Enter clientId' })

    yield* Effect.promise(async () =>
      session.registrySet.hasAgentRegistry.addApplicationRegistration(clientId)
    )
  })

export const mainPrompt = Effect.gen(function* () {
  const sessionManager = yield* SessionManager
  const session = yield* getSession.pipe(Effect.provideService(SessionManager, sessionManager))
  const action = yield* selectActionPrompt

  switch (action) {
    case Actions.createDataRegistration:
      yield* createDataRegistration(session)
      break
    case Actions.createSocialAgentRegistration:
      yield* createSocialAgentRegistration(session)
      break
    case Actions.createApplicationRegistration:
      yield* createApplicationRegistration(session)
      break
  }
})

const program = Effect.gen(function* () {
  yield* Console.log('Server starting')
  const server = yield* Effect.promise(() => createApp())
  yield* Effect.promise(() => server.start())
  yield* Console.log('Server started')
  yield* Effect.addFinalizer(() => Effect.promise(() => server.stop()))
  yield* Effect.provide(mainPrompt, SessionManagerLive)

  return 1
})

Effect.suspend(() => Effect.scoped(program)).pipe(
  Effect.provide(NodeContext.layer),
  Runtime.runMain
)

async function buildSession(account: Account): Promise<AuthorizationAgent> {
  const stu = new SolidTestUtils(account)
  await stu.auth()
  return await AuthorizationAgent.build(
    account.webId,
    `https://auth.example/${account.shortName}`,
    account.registrySet,
    {
      fetch: stu.authFetch,
      randomUUID: cuid,
    }
  )
}
