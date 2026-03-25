import repl from 'node:repl'
import { AuthorizationAgent } from '@janeirodigital/interop-authorization-agent'
import type { CRUDRegistrySet, CRUDRegistrySetData } from '@janeirodigital/interop-data-model'
import { init } from '@paralleldrive/cuid2'

import {
  type Account,
  SolidTestUtils,
  accounts,
  createApp,
  shapeTree,
} from '@janeirodigital/css-test-utils'

global.shapeTrees = shapeTree

global.cuid = init({ length: 6 })

global.bootstrapAccount = async function bootstrapAccount(
  account: Account,
  session: AuthorizationAgent
): Promise<CRUDRegistrySet> {
  const uriForContained = function uriForContained(containerId: string, container = false): string {
    const id = containerId + global.cuid()
    return container ? `${id}/` : id
  }

  // create Agent Registry
  const agentRegistryId = uriForContained(account.auth, true)
  const agentRegistry = await session.factory.crud.agentRegistry(agentRegistryId, {})
  await agentRegistry.create()

  // create Authorization Registry
  const authorizationRegistryId = uriForContained(account.auth, true)
  const authorizationRegistry = await session.factory.crud.authorizationRegistry(
    authorizationRegistryId,
    {}
  )
  await authorizationRegistry.create()

  const registrySetData: CRUDRegistrySetData = {
    hasAgentRegistry: agentRegistry.iri,
    hasAuthorizationRegistry: authorizationRegistry.iri,
    hasDataRegistry: [],
  }

  // create Data registries
  for (const resourceServer of Object.values(account.data)) {
    const dataRegistryId = uriForContained(resourceServer, true)
    const dataRegistry = await session.factory.crud.dataRegistry(dataRegistryId, {})
    await dataRegistry.create()
    registrySetData.hasDataRegistry.push(dataRegistry.iri)
  }

  const registrySetId = uriForContained(account.auth)
  const registrySet = await session.factory.crud.registrySet(registrySetId, registrySetData)
  await registrySet.update()

  return registrySet
}

global.buildSession = async function buildSession(account: Account): Promise<AuthorizationAgent> {
  const stu = new SolidTestUtils(account)
  await stu.auth()
  return await AuthorizationAgent.build(
    account.webId,
    `https://auth.example/${account.shortName}`,
    account.registrySet,
    {
      fetch: stu.authFetch,
      randomUUID: global.cuid,
    }
  )
}

global.accounts = accounts

global.server = await createApp()
await global.server.start()

repl.start('-> ')
