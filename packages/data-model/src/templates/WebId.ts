// TODO: https://github.com/hackers4peace/sai-js/issues/91

interface WebIdData {
  id: string
  document: string
  issuer: string
  uas: string
  registry: string
  issuance: string
}

export const webIdTemplate = ({
  id,
  document,
  issuer,
  uas,
  registry,
  issuance,
}: WebIdData): string => `
  PREFIX solid: <http://www.w3.org/ns/solid/terms#>
  PREFIX interop: <http://www.w3.org/ns/solid/interop#>

  GRAPH <${document}> {
    <${id}>
        solid:oidcIssuer <${issuer}>;
        interop:hasRegistrySet <${registry}>;
        interop:hasDelegationIssuanceEndpoint <${issuance}>;
        interop:hasAuthorizationAgent <${uas}> .
  }
`
