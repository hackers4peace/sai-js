import type { AgentAndClient } from './types.js'
interface DataGrantAcrData {
  id: string
  resource: string
  owner: AgentAndClient
  peer: AgentAndClient
}

export const dataGrantTemplate = ({ id, resource, owner, peer }: DataGrantAcrData): string => `
  PREFIX acl: <http://www.w3.org/ns/auth/acl#>
  PREFIX acp: <http://www.w3.org/ns/solid/acp#>
  <${id}#grant>
    a acp:AccessControlResource;
    acp:resource <${resource}>;
    acp:accessControl
      <${id}.acr#fullOwnerAccess>,
      <${id}.acr#peerReadAccess>;
    acp:memberAccessControl
      <${id}.acr#fullOwnerAccess>,
      <${id}.acr#peerReadAccess>.

  <${id}.acr#fullOwnerAccess>
    a acp:AccessControl;
    acp:apply [
      a acp:Policy;
      acp:allow acl:Read, acl:Write, acl:Control;
      acp:anyOf [
        a acp:Matcher;
        acp:agent <${owner.agent}>;
        acp:client <${owner.client}>
      ]
    ].

  <${id}.acr#peerReadAccess>
    a acp:AccessControl;
    acp:apply [
      a acp:Policy;
      acp:allow acl:Read;
      acp:anyOf [
        a acp:Matcher;
        acp:agent <${peer.agent}>;
        acp:client <${peer.client}>
      ]
    ].
`
