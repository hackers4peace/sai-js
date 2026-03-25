import type { NamedNode } from '@rdfjs/types'
import { DataFactory } from 'n3'

import { host } from './config'
import type { Account } from './types'

// TODO fix circular depencency with utils package
export function buildNamespace(base: string): any {
  const handler = {
    get: (target: { base: string }, property: string): NamedNode =>
      DataFactory.namedNode(target.base + property),
  }
  return new Proxy({ base }, handler)
}

export const INTEROP = buildNamespace('http://www.w3.org/ns/solid/interop#')
export const ACL = buildNamespace('http://www.w3.org/ns/auth/acl#')

const password = 'password'

export const shapeTree = {
  Gadget: `${host}/solid/trees/Gadget`,
  Widget: `${host}/solid/trees/Widget`,
  Event: `${host}/solid/trees/Event`,
  Contact: `${host}/solid/trees/Contact`,
}

export type Application = {
  clientId: string
}

export const luka: Account = {
  webId: `${host}/luka/profile/card#me`,
  email: 'luka@acme.example',
  shortName: 'luka',
  password,
  registrySet: 'http://localhost:3711/luka/yo73jo',
  auth: `${host}/luka/`,
  data: {
    corvax: `${host}/corvax/`,
    zenara: `${host}/zenara/`,
  },
}

export const vaporcg: Account = {
  webId: `${host}/vaporcg/profile/card#me`,
  email: 'admin@vaporcg.example',
  shortName: 'vaporcg',
  password,
  registrySet: 'http://localhost:3711/vaporcg/clqq3c',
  auth: `${host}/vaporcg/`,
  data: {
    vortiga: `${host}/vortiga/`,
    galathor: `${host}/galathor/`,
  },
}

export const solid: Account = {
  webId: `${host}/solid/profile/card#me`,
  email: 'admin@solid.example',
  shortName: 'solid',
  password,
  registrySet: 'TODO',
  auth: `${host}/solid/`,
  data: {
    solid: `${host}/solid/`,
  },
}

export const inspector: Application = {
  clientId: `${host}/solid/inspector/id`,
}

export const lukaForInspector = {
  granted: true,
  grantee: inspector.clientId,
  grantedBy: luka.webId,
  grantedWith: 'https://auth.example/luka',
  hasAccessNeedGroup: `${host}/solid/inspector/access-needs`,
  dataAuthorizations: [
    {
      grantee: inspector.clientId,
      grantedBy: luka.webId,
      registeredShapeTree: shapeTree.Gadget,
      accessMode: [ACL.Read.value, ACL.Update.value, ACL.Create.value, ACL.Delete.value],
      scopeOfAuthorization: INTEROP.All.value,
      children: [
        {
          grantee: inspector.clientId,
          grantedBy: luka.webId,
          registeredShapeTree: shapeTree.Widget,
          accessMode: [ACL.Read.value, ACL.Update.value, ACL.Create.value, ACL.Delete.value],
          scopeOfAuthorization: INTEROP.Inherited.value,
        },
      ],
    },
  ],
} as const

export const vaporcgForLuka = {
  granted: true,
  grantee: luka.webId,
  grantedBy: vaporcg.webId,
  grantedWith: 'https://auth.example/luka',
  dataAuthorizations: [
    {
      grantee: luka.webId,
      grantedBy: vaporcg.webId,
      registeredShapeTree: shapeTree.Gadget,
      accessMode: [ACL.Read.value, ACL.Update.value, ACL.Create.value, ACL.Delete.value],
      scopeOfAuthorization: INTEROP.All.value,
      children: [
        {
          grantee: luka.webId,
          grantedBy: vaporcg.webId,
          registeredShapeTree: shapeTree.Widget,
          accessMode: [ACL.Read.value, ACL.Update.value, ACL.Create.value, ACL.Delete.value],
          scopeOfAuthorization: INTEROP.Inherited.value,
        },
      ],
    },
  ],
} as const
