interface RegistrySetData {
  id: string
  webId: string
  uas: string
  dataRegistry: string
}

export const registrySetTemplate = ({ id, webId, uas, dataRegistry }: RegistrySetData): string => `
  PREFIX acl: <http://www.w3.org/ns/auth/acl#>
  PREFIX acp: <http://www.w3.org/ns/solid/acp#>
  PREFIX interop: <http://www.w3.org/ns/solid/interop#>
  PREFIX ldp: <http://www.w3.org/ns/ldp#>
  PREFIX space: <http://www.w3.org/ns/pim/space#>

  GRAPH <meta:${id}> {
    <${id}>
      a interop:RegistrySet, ldp:Resource, space:Storage;
      interop:hasAgentRegistry <${id}agent/>;
      interop:hasAuthorizationRegistry <${id}authorization/>;
      interop:hasGrantRegistry <${id}grant/>;
      interop:hasDataRegistry
        <${dataRegistry}>.
  }

  GRAPH <meta:${id}authorization/> {
    <${id}authorization/>
      a interop:AuthorizationRegistry, ldp:Resource.
  }

  GRAPH <meta:${id}grant/> {
    <${id}grant/>
      a interop:GrantRegistry, ldp:Resource.
  }

  GRAPH <meta:${id}agent/> {
    <${id}agent/>
      a interop:AuthorizationRegistry, ldp:Resource.
  }

  GRAPH <meta:${id}.acr> {
          <${id}.acr> a ldp:Resource .
  }

  GRAPH <${id}.acr> {
    <${id}.acr#root>
      a acp:AccessControlResource;
      acp:resource <${id}>;
      acp:accessControl
        <${id}.acr#fullOwnerAccess>;
      acp:memberAccessControl
        <${id}.acr#fullOwnerAccess>.

    <${id}.acr#fullOwnerAccess>
      a acp:AccessControl;
      acp:apply [
        a acp:Policy;
        acp:allow acl:Read, acl:Write, acl:Control;
        acp:anyOf [
          a acp:Matcher;
          acp:agent <${webId}>;
          acp:client <${uas}>
        ]
      ].
  }

`
